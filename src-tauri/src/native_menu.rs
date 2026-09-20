//! The macOS menubar adapter.  It deliberately knows nothing about React
//! state: the focused webview receives a stable command id and the frontend
//! returns derived enabled/checked/label state through `sync_native_menu`.

use std::{collections::HashMap, sync::Mutex};

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID},
    AppHandle, Emitter, Manager, Runtime,
};

pub const TOP_LEVEL_MENUS: [&str; 8] = [
    "Palisade", "File", "Edit", "View", "Go", "Run", "Window", "Help",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandState {
    pub enabled: bool,
    pub checked: Option<bool>,
    pub label: Option<String>,
}

pub struct NativeMenu<R: Runtime> {
    app: AppHandle<R>,
    normal: HashMap<String, Vec<MenuItem<R>>>,
    checks: HashMap<String, Vec<CheckMenuItem<R>>>,
    recent_menu: Submenu<R>,
    run_configurations_menu: Submenu<R>,
    recent_rows: Mutex<Vec<MenuItem<R>>>,
    run_configuration_rows: Mutex<Vec<MenuItem<R>>>,
}

impl<R: Runtime> NativeMenu<R> {
    fn normal(&mut self, app: &AppHandle<R>, id: &str, label: &str, accelerator: Option<&str>) -> tauri::Result<MenuItem<R>> {
        let item = MenuItem::with_id(app, format!("cmd.{id}"), label, false, accelerator)?;
        self.normal.entry(id.into()).or_default().push(item.clone());
        Ok(item)
    }

    fn check(&mut self, app: &AppHandle<R>, id: &str, label: &str, accelerator: Option<&str>) -> tauri::Result<CheckMenuItem<R>> {
        let item = CheckMenuItem::with_id(app, format!("cmd.{id}"), label, false, false, accelerator)?;
        self.checks.entry(id.into()).or_default().push(item.clone());
        Ok(item)
    }

    pub fn sync(&self, states: HashMap<String, CommandState>) {
        // Tauri menu items cannot be hidden. Replacing the dynamic submenu
        // contents is therefore intentional: absent state means absent UI,
        // never an empty or stale action row.
        self.replace_dynamic_rows(&self.recent_menu, &self.recent_rows, &states, "project.recent.", "No Recent Projects", 0);
        self.replace_dynamic_rows(&self.run_configurations_menu, &self.run_configuration_rows, &states, "run.config.", "No Run Configurations", usize::MAX);
        for (id, state) in states {
            if let Some(items) = self.normal.get(&id) {
                for item in items {
                    let _ = item.set_enabled(state.enabled);
                    if let Some(label) = state.label.as_deref() { let _ = item.set_text(label); }
                }
            }
            if let Some(items) = self.checks.get(&id) {
                for item in items {
                    let _ = item.set_enabled(state.enabled);
                    if let Some(label) = state.label.as_deref() { let _ = item.set_text(label); }
                    if let Some(checked) = state.checked { let _ = item.set_checked(checked); }
                }
            }
        }
    }

    fn replace_dynamic_rows(
        &self,
        submenu: &Submenu<R>,
        existing: &Mutex<Vec<MenuItem<R>>>,
        states: &HashMap<String, CommandState>,
        prefix: &str,
        empty_label: &str,
        insert_at: usize,
    ) {
        let mut existing = existing.lock().expect("native menu dynamic rows lock poisoned");
        for item in existing.drain(..) {
            let _ = submenu.remove(&item);
        }
        let rows = dynamic_rows(states, prefix);
        if rows.is_empty() {
            if let Ok(item) = MenuItem::with_id(&self.app, format!("placeholder.{prefix}"), empty_label, false, None::<&str>) {
                let position = if insert_at == usize::MAX { submenu.items().map_or(0, |items| items.len()) } else { insert_at };
                let _ = submenu.insert(&item, position);
                existing.push(item);
            }
            return;
        }
        for (offset, (slot, label, enabled)) in rows.into_iter().enumerate() {
            if let Ok(item) = MenuItem::with_id(&self.app, format!("cmd.{prefix}{slot}"), label, enabled, None::<&str>) {
                let position = if insert_at == usize::MAX { submenu.items().map_or(0, |items| items.len()) } else { insert_at + offset };
                let _ = submenu.insert(&item, position);
                existing.push(item);
            }
        }
    }
}

/// Rows supplied by the focused renderer. A missing slot is deliberately not
/// represented in the native menu: no label means there is no safe action.
fn dynamic_rows(states: &HashMap<String, CommandState>, prefix: &str) -> Vec<(usize, String, bool)> {
    let mut rows = states.iter().filter_map(|(id, state)| {
        let slot = id.strip_prefix(prefix)?.parse::<usize>().ok()?;
        Some((slot, state.label.clone()?, state.enabled))
    }).collect::<Vec<_>>();
    rows.sort_by_key(|(slot, _, _)| *slot);
    rows
}

fn adjacent_window_label<'a>(labels: &'a [String], focused: &str, direction: isize) -> Option<&'a str> {
    if labels.len() < 2 { return None; }
    let current = labels.iter().position(|label| label == focused)?;
    let next = (current as isize + direction).rem_euclid(labels.len() as isize) as usize;
    Some(labels[next].as_str())
}

/// Builds all user-visible menu rows. Rows begin disabled: the frontend owns
/// truth for focused-window state, and enables only commands it can execute.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<NativeMenu<R>> {
    let mut native = NativeMenu {
        app: app.clone(), normal: HashMap::new(), checks: HashMap::new(),
        recent_menu: Submenu::new(app, "Open Recent", true)?,
        run_configurations_menu: Submenu::new(app, "Run Configuration", true)?,
        recent_rows: Mutex::new(Vec::new()), run_configuration_rows: Mutex::new(Vec::new()),
    };
    let sep = || PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(app, Some("About Palisade"), None)?;
    let updates = native.normal(app, "app.checkUpdates", "Check for Updates…", None)?;
    let settings = native.normal(app, "app.settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide Palisade"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = native.normal(app, "app.quit", "Quit Palisade", Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(app, TOP_LEVEL_MENUS[0], true, &[&about, &updates, &sep()?, &settings, &sep()?, &services, &sep()?, &hide, &hide_others, &show_all, &sep()?, &quit])?;

    let new_file = native.normal(app, "file.new", "New File…", Some("CmdOrCtrl+N"))?;
    let new_thread = native.normal(app, "thread.new", "New Thread…", Some("CmdOrCtrl+Shift+N"))?;
    let open_project = native.normal(app, "project.open", "Open Project…", Some("CmdOrCtrl+O"))?;
    let clear_recent = native.normal(app, "project.recent.clear", "Clear Menu", None)?;
    let recent_separator = sep()?;
    native.recent_menu.append(&recent_separator)?;
    native.recent_menu.append(&clear_recent)?;
    let clone = native.normal(app, "project.clone", "Clone Repository…", None)?;
    let new_window = native.normal(app, "project.newWindow", "Open Current Project in New Window", None)?;
    let project_settings = native.normal(app, "app.projectSettings", "Open Project Settings", None)?;
    let save = native.normal(app, "file.save", "Save", Some("CmdOrCtrl+S"))?;
    let close_tab = native.normal(app, "tab.close", "Close Tab", Some("CmdOrCtrl+W"))?;
    let reopen = native.normal(app, "tab.reopen", "Reopen Closed Tab", Some("CmdOrCtrl+Shift+T"))?;
    let close_window = native.normal(app, "window.close", "Close Window", Some("CmdOrCtrl+Shift+W"))?;
    let file = Submenu::with_items(app, TOP_LEVEL_MENUS[1], true, &[&new_file, &new_thread, &sep()?, &open_project, &native.recent_menu, &clone, &new_window, &sep()?, &project_settings, &sep()?, &save, &sep()?, &close_tab, &reopen, &close_window])?;

    let undo = PredefinedMenuItem::undo(app, None)?; let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?; let copy = PredefinedMenuItem::copy(app, None)?; let paste = PredefinedMenuItem::paste(app, None)?; let select_all = PredefinedMenuItem::select_all(app, None)?;
    let find = native.normal(app, "editor.find", "Find…", Some("CmdOrCtrl+F"))?;
    let find_next = native.normal(app, "editor.findNext", "Find Next", Some("CmdOrCtrl+G"))?;
    let find_previous = native.normal(app, "editor.findPrevious", "Find Previous", Some("CmdOrCtrl+Shift+G"))?;
    let find_project = native.normal(app, "file.search", "Find in Project…", Some("CmdOrCtrl+Shift+F"))?;
    let edit = Submenu::with_items(app, TOP_LEVEL_MENUS[2], true, &[&undo, &redo, &sep()?, &cut, &copy, &paste, &select_all, &sep()?, &find, &find_next, &find_previous, &find_project])?;

    let palette = native.normal(app, "help.commands", "Command Palette…", Some("CmdOrCtrl+Shift+P"))?;
    let theme_system = native.check(app, "view.theme.auto", "System", None)?; let theme_light = native.check(app, "view.theme.light", "Light", None)?; let theme_dark = native.check(app, "view.theme.dark", "Dark", None)?;
    let appearance = Submenu::with_items(app, "Appearance", true, &[&theme_system, &theme_light, &theme_dark])?;
    let side = native.normal(app, "view.leftRail", "Show/Hide Side Panel", Some("CmdOrCtrl+\\"))?;
    let secondary = native.normal(app, "view.rightPanel", "Show/Hide Chat Panel", Some("CmdOrCtrl+J"))?;
    let terminal = native.normal(app, "view.terminal", "Show/Hide Terminal", Some("Ctrl+`"))?;
    let changes = native.normal(app, "view.diff", "Show/Hide Changes", None)?;
    let markdown = native.normal(app, "view.markdownPreview", "Toggle Markdown Preview", Some("CmdOrCtrl+Shift+V"))?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some("Enter Full Screen"))?;
    let view = Submenu::with_items(app, TOP_LEVEL_MENUS[3], true, &[&palette, &sep()?, &appearance, &sep()?, &side, &secondary, &terminal, &changes, &markdown, &sep()?, &fullscreen])?;

    let go_file = native.normal(app, "file.open", "Go to File…", Some("CmdOrCtrl+P"))?;
    let go_line = native.normal(app, "editor.goToLine", "Go to Line…", Some("Ctrl+G"))?;
    let definition = native.normal(app, "editor.goToDefinition", "Go to Definition", Some("F12"))?;
    let next_tab = native.normal(app, "tab.next", "Next Tab", Some("Ctrl+Tab"))?;
    let previous_tab = native.normal(app, "tab.previous", "Previous Tab", Some("Ctrl+Shift+Tab"))?;
    let go = Submenu::with_items(app, TOP_LEVEL_MENUS[4], true, &[&go_file, &go_line, &definition, &sep()?, &next_tab, &previous_tab])?;

    let run_last = native.normal(app, "run.last", "Run Last Configuration", None)?;
    let configure_runs = native.normal(app, "run.configure", "Configure Run Commands…", None)?;
    let debug_start = native.normal(app, "debug.start", "Start Debugging", Some("F5"))?;
    let debug_stop = native.normal(app, "debug.stop", "Stop Debugging", Some("Shift+F5"))?;
    let stop_agent = native.normal(app, "agent.stop", "Stop Active Agent Session", None)?;
    let run = Submenu::with_items(app, TOP_LEVEL_MENUS[5], true, &[&run_last, &native.run_configurations_menu, &configure_runs, &sep()?, &debug_start, &debug_stop, &sep()?, &stop_agent])?;

    let minimize = PredefinedMenuItem::minimize(app, None)?; let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;
    let next_window = native.normal(app, "window.next", "Next Window", Some("CmdOrCtrl+`"))?;
    let previous_window = native.normal(app, "window.previous", "Previous Window", Some("CmdOrCtrl+Shift+`"))?;
    // These are native actions, not renderer commands, so the renderer never
    // includes them in its state payload. Keep them available even before the
    // first state sync (they harmlessly no-op with fewer than two windows).
    next_window.set_enabled(true)?;
    previous_window.set_enabled(true)?;
    let bring_all = PredefinedMenuItem::bring_all_to_front(app, None)?;
    // Tauri recognizes this reserved id and lets macOS populate open-window
    // entries, including the focused-window checkmark.
    let window = Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, TOP_LEVEL_MENUS[6], true, &[&minimize, &zoom, &sep()?, &next_window, &previous_window, &sep()?, &bring_all])?;

    let commands = native.normal(app, "help.commands", "Commands and Shortcuts…", Some("CmdOrCtrl+Shift+P"))?;
    let feedback = native.normal(app, "help.feedback", "Report a Bug / Request a Feature…", None)?;
    let help = Submenu::with_items(app, TOP_LEVEL_MENUS[7], true, &[&commands, &sep()?, &feedback])?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &run, &window, &help])?.set_as_app_menu()?;
    native.sync(HashMap::new());
    Ok(native)
}

pub fn dispatch_to_focused_window<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(command) = id.strip_prefix("cmd.") else { return };
    if command == "window.next" || command == "window.previous" {
        let mut windows = app.webview_windows().into_values().collect::<Vec<_>>();
        windows.sort_by(|a, b| a.label().cmp(b.label()));
        let labels = windows.iter().map(|window| window.label().to_string()).collect::<Vec<_>>();
        let focused = windows.iter().find(|window| window.is_focused().unwrap_or(false));
        let direction = if command == "window.next" { 1 } else { -1 };
        if let Some(target) = focused.and_then(|window| adjacent_window_label(&labels, window.label(), direction)) {
            if let Some(window) = windows.into_iter().find(|window| window.label() == target) { let _ = window.set_focus(); }
        }
        return;
    }
    if let Some(window) = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false)) {
        // Addressed, never broadcast: `emit` fans out to every webview no
        // matter which one it is called on, which would run the command in
        // every open project window instead of the focused one. Both halves
        // matter — a JS `listen` with no `target` option registers as
        // `EventTarget::Any` and receives everything regardless of this
        // filter, so App.tsx scopes its listener to the window label too.
        let _ = window.emit_to(window.label(), "native-command", command);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_has_exactly_the_approved_top_level_names() {
        assert_eq!(TOP_LEVEL_MENUS, ["Palisade", "File", "Edit", "View", "Go", "Run", "Window", "Help"]);
    }

    #[test]
    fn next_and_previous_window_wrap_across_actual_palisade_windows() {
        let windows = vec!["main".to_string(), "project-alpha".to_string(), "project-bravo".to_string()];

        assert_eq!(adjacent_window_label(&windows, "project-alpha", 1), Some("project-bravo"));
        assert_eq!(adjacent_window_label(&windows, "project-alpha", -1), Some("main"));
        assert_eq!(adjacent_window_label(&windows, "project-bravo", 1), Some("main"));
        assert_eq!(adjacent_window_label(&windows, "main", -1), Some("project-bravo"));
    }

    /// `Emitter::emit` is a default trait method that always fans out to
    /// every target, whatever the receiver — so emitting from the focused
    /// window still ran the command in every other window. Only `emit_to`
    /// is scoped, and nothing here can observe that at runtime without a
    /// live webview, so guard the call shape itself.
    #[test]
    fn native_commands_are_addressed_to_one_window_never_broadcast() {
        let source = include_str!("native_menu.rs");
        let dispatch = source
            .split_once("pub fn dispatch_to_focused_window")
            .expect("dispatcher exists").1
            .split_once("#[cfg(test)]")
            .map_or(source, |(body, _)| body);

        assert!(!dispatch.contains(".emit(\"native-command\""), "native-command must not be broadcast to every window");
        assert!(dispatch.contains("emit_to("), "native-command must be addressed to the focused window's label");
    }

    #[test]
    fn dynamic_rows_include_only_currently_populated_actions() {
        let mut states = HashMap::new();
        states.insert("project.recent.0".into(), CommandState { enabled: true, checked: None, label: Some("Alpha".into()) });
        states.insert("project.recent.2".into(), CommandState { enabled: true, checked: None, label: Some("Charlie".into()) });

        assert_eq!(dynamic_rows(&states, "project.recent."), vec![
            (0, "Alpha".to_string(), true),
            (2, "Charlie".to_string(), true),
        ]);
        assert!(dynamic_rows(&states, "run.config.").is_empty());
    }
}
