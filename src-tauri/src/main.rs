// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Re-invoked to babysit a sidecar (the completion server, a notebook
    // kernel) so it dies the instant this process does, by any means — see
    // `pidguard::spawn_supervised`. Must run before Tauri touches anything;
    // this invocation never becomes the real app.
    if palisade_code_lib::pidguard_supervisor_requested() {
        palisade_code_lib::run_pidguard_supervisor();
    }
    palisade_code_lib::run()
}
