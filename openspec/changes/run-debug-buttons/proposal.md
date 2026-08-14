## Why

Developers expect quick access to run common project commands (dev servers, test suites, builds) without manually typing them in the terminal every time. The timing is right because the terminal pane already exists and works well, so adding run buttons is a UI enhancement that builds on existing infrastructure. This makes Floo feel more like a complete development environment rather than just an agent interface. (D7)

## What Changes

- Add run button (split button with primary action + dropdown) in the editor tab bar next to file names (TabBar.tsx)
- Extend `.project-settings.json` with a `run` field (HashMap<String, String>) for command name → shell command mappings (settings.rs)
- Add IPC command to write commands to the terminal PTY (terminal.rs)
- Register terminal IPC command in lib.rs and add TypeScript wrapper (api.ts)
- Implement "no config" onboarding flow that helps users create their first "run current file" configuration when the button is clicked
- Primary action remembers last-used command, dropdown shows all configured commands

## Capabilities

### New Capabilities

- `run-commands`: Quick-access run button in the editor tab bar that executes configured project commands in the terminal pane, with configuration stored in `.project-settings.json` and onboarding for first-time users.

## Impact

**Affected code:**
- Modified: `src/TabBar.tsx` (run button UI), `src-tauri/src/settings.rs` (ProjectSettings), `src-tauri/src/terminal.rs` (IPC command), `src-tauri/src/lib.rs` (IPC registration), `src/api.ts` (TypeScript wrapper)

**No new dependencies** - uses existing Mantine components and terminal infrastructure
