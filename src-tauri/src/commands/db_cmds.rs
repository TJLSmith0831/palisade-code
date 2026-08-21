//! IPC surface for the database viewer/editor. Every command resolves the
//! saved connection itself from `~/.palisade-code` — the frontend passes a
//! connection id, never a URL, so a credential only ever travels one way.

use crate::db::{self, ColumnInfo, DbConnection, Filter, Page, QueryResult, RowEdit, Sort, TableInfo};
use crate::store::palisade_home;
use crate::Res;

fn connection(project_hash: &str, connection_id: &str) -> Res<DbConnection> {
    db::find_connection(&palisade_home(), project_hash, connection_id)
}

#[tauri::command]
pub async fn db_list_connections(project_hash: String) -> Res<Vec<DbConnection>> {
    db::list_connections(&palisade_home(), &project_hash)
}

/// Proves the connection string actually connects before it is written, so a
/// broken one is reported instead of saved (spec: Invalid connection string).
#[tauri::command]
pub async fn db_add_connection(project_hash: String, name: String, url: String) -> Res<DbConnection> {
    let candidate = DbConnection {
        id: String::new(),
        name: name.trim().to_string(),
        url: url.trim().to_string(),
        backend: db::backend_of(url.trim())?,
    };
    db::pool_for(&candidate).await?;
    db::forget_pool(&candidate.url);
    db::add_connection(&palisade_home(), &project_hash, &name, &url)
}

#[tauri::command]
pub async fn db_remove_connection(project_hash: String, connection_id: String) -> Res<()> {
    if let Ok(conn) = connection(&project_hash, &connection_id) {
        db::forget_pool(&conn.url);
    }
    db::remove_connection(&palisade_home(), &project_hash, &connection_id)
}

#[tauri::command]
pub async fn db_rename_connection(
    project_hash: String,
    connection_id: String,
    name: String,
) -> Res<DbConnection> {
    db::rename_connection(&palisade_home(), &project_hash, &connection_id, &name)
}

#[tauri::command]
pub async fn db_list_tables(project_hash: String, connection_id: String) -> Res<Vec<TableInfo>> {
    db::list_tables(&connection(&project_hash, &connection_id)?).await
}

#[tauri::command]
pub async fn db_table_columns(
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> Res<Vec<ColumnInfo>> {
    db::columns_of(&connection(&project_hash, &connection_id)?, schema.as_deref(), &table).await
}

#[tauri::command]
pub async fn db_fetch_page(
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    page: i64,
    sort: Option<Sort>,
    filter: Option<Filter>,
) -> Res<Page> {
    db::fetch_page(
        &connection(&project_hash, &connection_id)?,
        schema.as_deref(),
        &table,
        page,
        sort.as_ref(),
        filter.as_ref(),
    )
    .await
}

#[tauri::command]
pub async fn db_run_query(project_hash: String, connection_id: String, sql: String) -> Res<QueryResult> {
    db::run_query(&connection(&project_hash, &connection_id)?, &sql).await
}

/// The confirm gate's single source of truth (D12) — the frontend asks rather
/// than keeping a second copy of the pattern that could drift from this one.
#[tauri::command]
pub async fn db_is_destructive(sql: String) -> Res<bool> {
    Ok(db::is_destructive(&sql))
}

#[tauri::command]
pub async fn db_preview_edits(
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    edits: Vec<RowEdit>,
) -> Res<Vec<String>> {
    db::preview_edits(
        &connection(&project_hash, &connection_id)?,
        schema.as_deref(),
        &table,
        &edits,
    )
    .await
}

#[tauri::command]
pub async fn db_apply_edits(
    project_hash: String,
    connection_id: String,
    schema: Option<String>,
    table: String,
    edits: Vec<RowEdit>,
) -> Res<i64> {
    db::apply_edits(
        &connection(&project_hash, &connection_id)?,
        schema.as_deref(),
        &table,
        &edits,
    )
    .await
}
