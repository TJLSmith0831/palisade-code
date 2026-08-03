mod store;

use std::path::{Path, PathBuf};

use store::{floo_home, Message, Project, Res, ThreadMeta};

/// Notes live inside the target project, so every note command resolves the
/// project's root from the global index rather than trusting the frontend.
fn project_root(hash: &str) -> Res<PathBuf> {
    let home = floo_home();
    store::list_projects(&home)?
        .into_iter()
        .find(|p| p.hash == hash)
        .map(|p| PathBuf::from(p.root))
        .ok_or_else(|| format!("unknown project: {hash}"))
}

#[tauri::command]
fn list_projects() -> Res<Vec<Project>> {
    store::list_projects(&floo_home())
}

#[tauri::command]
fn add_project(path: String) -> Res<Project> {
    store::add_project(&floo_home(), Path::new(&path))
}

#[tauri::command]
fn switch_project(hash: String) -> Res<Project> {
    store::touch_project(&floo_home(), &hash)
}

#[tauri::command]
fn rename_project(hash: String, display_name: String) -> Res<Project> {
    store::rename_project(&floo_home(), &hash, &display_name)
}

#[tauri::command]
fn create_thread(project_hash: String, title: String) -> Res<ThreadMeta> {
    store::create_thread(&floo_home(), &project_hash, &title)
}

#[tauri::command]
fn list_threads(project_hash: String) -> Res<Vec<ThreadMeta>> {
    store::list_threads(&floo_home(), &project_hash)
}

#[tauri::command]
fn rename_thread(project_hash: String, thread_id: String, title: String) -> Res<ThreadMeta> {
    store::rename_thread(&floo_home(), &project_hash, &thread_id, &title)
}

#[tauri::command]
fn set_thread_mode(project_hash: String, thread_id: String, mode: String) -> Res<ThreadMeta> {
    store::set_thread_mode(&floo_home(), &project_hash, &thread_id, &mode)
}

#[tauri::command]
fn append_message(
    project_hash: String,
    thread_id: String,
    role: String,
    mode: String,
    content: String,
) -> Res<Message> {
    store::append_message(&floo_home(), &project_hash, &thread_id, &role, &mode, &content)
}

#[tauri::command]
fn read_thread(project_hash: String, thread_id: String) -> Res<Vec<Message>> {
    store::read_thread(&floo_home(), &project_hash, &thread_id)
}

#[tauri::command]
fn create_note(project_hash: String, name: String) -> Res<String> {
    store::create_note(&project_root(&project_hash)?, &name)
}

#[tauri::command]
fn list_notes(project_hash: String) -> Res<Vec<String>> {
    store::list_notes(&project_root(&project_hash)?)
}

#[tauri::command]
fn read_note(project_hash: String, name: String) -> Res<String> {
    store::read_note(&project_root(&project_hash)?, &name)
}

#[tauri::command]
fn write_note(project_hash: String, name: String, content: String) -> Res<()> {
    store::write_note(&project_root(&project_hash)?, &name, &content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(debug_assertions)]
    {
        // Default binds 0.0.0.0, which would expose the bridge to the LAN.
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }
    builder
        .invoke_handler(tauri::generate_handler![
            list_projects,
            add_project,
            switch_project,
            rename_project,
            create_thread,
            list_threads,
            rename_thread,
            set_thread_mode,
            append_message,
            read_thread,
            create_note,
            list_notes,
            read_note,
            write_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
