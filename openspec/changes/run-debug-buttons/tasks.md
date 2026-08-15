## 1. Run configuration in ProjectSettings

- [ ] 1.1 Write failing Rust test: ProjectSettings with run field round-trips through serde (RED)
- [ ] 1.2 Write failing Rust test: ProjectSettings without run field still loads (backward compat) (RED)
- [ ] 1.3 Add `run: HashMap<String, String>` field to ProjectSettings struct in `src-tauri/src/settings.rs`
- [ ] 1.4 Update `.project-settings.json` default contents to include empty `run` field
- [ ] 1.5 Run `cargo test settings::` to verify settings tests pass
- [ ] 1.6 Test manual editing of run config in `.project-settings.json` to verify it loads correctly

## 2. Terminal IPC command for command execution

- [ ] 2.1 Write failing Rust test: write_to_terminal IPC command writes string to PTY (RED)
- [ ] 2.2 Write failing Rust test: write_to_terminal IPC command handles newline termination (RED)
- [ ] 2.3 Add `write_to_terminal` command to `src-tauri/src/terminal.rs` with project hash and command parameters
- [ ] 2.4 Add `write_to_terminal` command to `generate_handler!` registry in `src-tauri/src/lib.rs`
- [ ] 2.5 Run `cargo test terminal::` to verify terminal tests pass
- [ ] 2.6 Test write_to_terminal via Tauri devtools to verify it writes to the terminal

## 3. TypeScript API wrappers for terminal command

- [ ] 3.1 Write failing TS test: `api.writeToTerminal` calls the correct IPC command with parameters (RED)
- [ ] 3.2 Add `writeToTerminal` function to `src/api.ts` with proper TypeScript types
- [ ] 3.3 Run relevant TS test file to verify API wrapper tests pass

## 4. TabBar run button UI (riskiest first)

- [ ] 4.1 Write failing TS test: Run button appears in tab bar when file is open (RED)
- [ ] 4.2 Write failing TS test: Run button is a split button with primary action and dropdown (RED)
- [ ] 4.3 Write failing TS test: Clicking dropdown shows configured run commands (RED)
- [ ] 4.4 Add run button component to `src/TabBar.tsx` using Mantine components (ActionIcon, Menu)
- [ ] 4.5 Implement split button behavior (primary action click vs dropdown click)
- [ ] 4.6 Wire run button to load run commands from project settings
- [ ] 4.7 Run relevant TS test file to verify TabBar run button tests pass

## 5. Run command execution

- [ ] 5.1 Write failing TS test: Clicking run button primary action executes command via api.writeToTerminal (RED)
- [ ] 5.2 Write failing TS test: Command execution focuses the terminal pane (RED)
- [ ] 5.3 Wire run button primary action to call api.writeToTerminal with selected command
- [ ] 5.4 Add terminal pane focus logic after command execution
- [ ] 5.5 Run relevant TS test file to verify run execution tests pass
- [ ] 5.6 Manual test: Click run button, verify command executes in terminal with visible output

## 6. Last-used command memory

- [ ] 6.1 Write failing TS test: Selecting a command from dropdown updates primary action for next click (RED)
- [ ] 6.2 Write failing TS test: Last-used command persists across file switches (RED)
- [ ] 6.3 Add state to track last-used run command in TabBar component
- [ ] 6.4 Update primary action to use last-used command when available
- [ ] 6.5 Run relevant TS test file to verify last-used memory tests pass

## 7. No-configuration onboarding flow

- [ ] 7.1 Write failing TS test: Clicking run button with no config shows onboarding prompt (RED)
- [ ] 7.2 Write failing TS test: Accepting onboarding creates simple "run current file" config (RED)
- [ ] 7.3 Add onboarding modal/dialog to TabBar component
- [ ] 7.4 Implement language-specific default command generation (e.g., `npm run dev` for Node.js, `python file.py` for Python)
- [ ] 7.5 Wire onboarding acceptance to write config to project settings
- [ ] 7.6 Run relevant TS test file to verify onboarding tests pass
- [ ] 7.7 Manual test: Click run button on new project, verify onboarding prompt appears and creates config

## 8. Run command persistence

- [ ] 8.1 Write failing TS test: Creating run config writes to .project-settings.json (RED)
- [ ] 8.2 Write failing TS test: Run config loads correctly on project reload (RED)
- [ ] 8.3 Add IPC command to update project settings with new run config
- [ ] 8.4 Register settings update command in lib.rs and add TypeScript wrapper
- [ ] 8.5 Wire onboarding and manual config creation to use settings update command
- [ ] 8.6 Run relevant TS test file to verify persistence tests pass
- [ ] 8.7 Manual test: Create run config, close and reopen project, verify config persists

## 9. End-to-end verification

- [ ] 9.1 Manual test: Open project with run config, verify run button appears in tab bar
- [ ] 9.2 Manual test: Click run button primary action, verify command executes in terminal
- [ ] 9.3 Manual test: Click dropdown, select alternative command, verify it executes and becomes primary
- [ ] 9.4 Manual test: Open project without run config, click run button, verify onboarding appears
- [ ] 9.5 Manual test: Accept onboarding, verify config is created and command executes
- [ ] 9.6 Manual test: Switch between files, verify last-used command memory works
- [ ] 9.7 Manual test: Edit .project-settings.json manually, verify run button reflects changes
- [ ] 9.8 Run full frontend test suite: `pnpm test`
- [ ] 9.9 Run full Rust test suite: `cd src-tauri && cargo test`
- [ ] 9.10 Run Tauri dev build: `pnpm start` and verify no startup errors
