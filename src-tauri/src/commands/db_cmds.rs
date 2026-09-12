//! IPC surface for the database viewer/editor. Every command resolves the
//! saved connection itself from `~/.palisade-code` — the frontend passes a
//! connection id, never a URL, so a credential only ever travels one way.

use crate::db::{
    self, AuditEntry, ColumnInfo, DbConnection, Details, Filter, Page, QueryResult, RowEdit, Sort,
    TableInfo,
};
use crate::store::palisade_home;
use crate::Res;
use tauri::Emitter;

/// Surfaces degraded credential storage the way `settings::load`'s warning
/// does — the module returns it, the command layer emits it (D8).
fn warn(app: &tauri::AppHandle, warning: Option<String>) {
    if let Some(message) = warning {
        let _ = app.emit("harness-warning", message);
    }
}

/// A connection without its secret — enough to name it in an audit entry.
fn connection(project_hash: &str, connection_id: &str) -> Res<DbConnection> {
    db::find_connection(&palisade_home(), project_hash, connection_id)
}

/// A connection ready to open: resolves the password, splitting a pre-fields
/// record on the way. This is the only path that touches the credential store,
/// so the OS prompts on connect rather than on panel open (D23).
fn connect(app: &tauri::AppHandle, project_hash: &str, connection_id: &str) -> Res<DbConnection> {
    let listed = connection(project_hash, connection_id)?;
    let (resolved, warning) = db::with_secret(&palisade_home(), project_hash, &listed)?;
    warn(app, warning);
    Ok(resolved)
}

/// Records one entry. Recording never changes an operation's result (D6) —
/// a failed append is warned about and nothing else.
fn record(app: &tauri::AppHandle, project_hash: &str, entry: AuditEntry) {
    if let Err(message) = db::append_audit(&palisade_home(), project_hash, &entry) {
        let _ = app.emit("harness-warning", format!("Database history not recorded: {message}"));
    }
}

#[tauri::command]
pub async fn db_list_connections(
    app: tauri::AppHandle,
    project_hash: String,
) -> Res<Vec<DbConnection>> {
    // Credential-store reads are blocking sync I/O and can raise a modal OS
    // prompt, so they stay off the async runtime (D17) — same as `lib.rs` does
    // for store I/O.
    let (connections, warning) =
        tokio::task::spawn_blocking(move || db::list_connections(&palisade_home(), &project_hash))
            .await
            .map_err(|err| crate::PalisadeError::from(err.to_string()))??;
    warn(&app, warning);
    Ok(connections)
}

/// Proves the connection string actually connects before it is written, so a
/// broken one is reported instead of saved (spec: Invalid connection string).
#[tauri::command]
pub async fn db_add_connection(
    app: tauri::AppHandle,
    project_hash: String,
    name: String,
    details: Details,
    password: Option<String>,
) -> Res<DbConnection> {
    let candidate = DbConnection {
        id: String::new(),
        name: name.trim().to_string(),
        details: details.clone(),
        password: password.clone(),
    };
    db::pool_for(&candidate).await?;
    db::forget_pool(&candidate);
    let hash = project_hash.clone();
    let (conn, warning) = tokio::task::spawn_blocking(move || {
        db::add_connection(&palisade_home(), &project_hash, &name, details, password.as_deref())
    })
    .await
    .map_err(|err| crate::PalisadeError::from(err.to_string()))??;
    warn(&app, warning);
    record(&app, &hash, AuditEntry::new("connection.add", &conn));
    Ok(conn)
}

#[tauri::command]
pub async fn db_remove_connection(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
) -> Res<()> {
    if let Ok(conn) = connection(&project_hash, &connection_id) {
        db::forget_pool(&conn);
        record(&app, &project_hash, AuditEntry::new("connection.remove", &conn));
    }
    let project_hash = project_hash.clone();
    tokio::task::spawn_blocking(move || {
        db::remove_connection(&palisade_home(), &project_hash, &connection_id)
    })
    .await
    .map_err(|err| crate::PalisadeError::from(err.to_string()))?
}

#[tauri::command]
pub async fn db_rename_connection(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    name: String,
) -> Res<DbConnection> {
    let conn = db::rename_connection(&palisade_home(), &project_hash, &connection_id, &name)?;
    record(&app, &project_hash, AuditEntry::new("connection.rename", &conn));
    Ok(conn)
}

#[tauri::command]
pub async fn db_list_tables(app: tauri::AppHandle, project_hash: String, connection_id: String) -> Res<Vec<TableInfo>> {
    db::list_tables(&connect(&app, &project_hash, &connection_id)?).await
}

#[tauri::command]
pub async fn db_table_columns(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> Res<Vec<ColumnInfo>> {
    db::columns_of(&connect(&app, &project_hash, &connection_id)?, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn db_fetch_page(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    page: i64,
    sort: Option<Sort>,
    filter: Option<Filter>,
) -> Res<Page> {
    db::fetch_page(
        &connect(&app, &project_hash, &connection_id)?,
        schema.as_deref(),
        &table,
        page,
        sort.as_ref(),
        filter.as_ref(),
    )
    .await
}

#[tauri::command]
pub async fn db_run_query(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    sql: String,
) -> Res<QueryResult> {
    let conn = connect(&app, &project_hash, &connection_id)?;
    let result = db::run_query(&conn, &sql).await;
    record(
        &app,
        &project_hash,
        AuditEntry::new("query", &conn)
            .statement(&sql)
            .outcome(&result, |r: &QueryResult| r.rows_affected),
    );
    result
}

/// Splits a pasted connection string into fields for the add form (D24).
/// Parsing lives here so the frontend and backend cannot disagree about what a
/// URL means — the same function migration uses.
#[tauri::command]
pub async fn db_parse_url(url: String) -> Res<ParsedUrl> {
    let (details, password) = db::parse_url(&url)?;
    Ok(ParsedUrl { details, password })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    pub details: Details,
    pub password: Option<String>,
}

/// The confirm gate's single source of truth (D12) — the frontend asks rather
/// than keeping a second copy of the pattern that could drift from this one.
#[tauri::command]
pub async fn db_is_destructive(sql: String) -> Res<bool> {
    Ok(db::is_destructive(&sql))
}

#[tauri::command]
pub async fn db_preview_edits(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    edits: Vec<RowEdit>,
) -> Res<Vec<String>> {
    db::preview_edits(
        &connect(&app, &project_hash, &connection_id)?,
        schema.as_deref(),
        &table,
        &edits,
    )
    .await
}

#[tauri::command]
pub async fn db_apply_edits(
    app: tauri::AppHandle,
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    edits: Vec<RowEdit>,
) -> Res<i64> {
    let conn = connect(&app, &project_hash, &connection_id)?;
    // The transaction inside `apply_edits` is untouched: the entry is appended
    // after it settles, carrying whatever it actually did (D7).
    let result = db::apply_edits(&conn, schema.as_deref(), &table, &edits).await;
    let statements = db::preview_edits(&conn, schema.as_deref(), &table, &edits)
        .await
        .unwrap_or_default()
        .join("; ");
    record(
        &app,
        &project_hash,
        AuditEntry::new("edit", &conn)
            .at(schema.as_deref(), &table)
            .statement(&statements)
            .outcome(&result, |rows: &i64| Some(*rows)),
    );
    result
}
