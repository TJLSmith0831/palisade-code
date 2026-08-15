## Context

Floo's editor currently has a tab bar (TabBar.tsx) that shows open file names with close buttons. The terminal pane (TerminalPane.tsx) already exists and can execute commands via PTY. The `.project-settings.json` file already has a pattern for project-specific configuration (format_on_save, verify commands, executor_override). This change adds run buttons to the tab bar that execute configured commands in the existing terminal pane.

## Goals / Non-Goals

**Goals:**
- Provide quick access to run project commands via a split button in the editor tab bar
- Store run configurations in `.project-settings.json` following existing patterns
- Execute commands in the existing terminal pane without new infrastructure
- Provide onboarding for first-time users when no configuration exists

**Non-Goals:**
- Traditional debugger integration (breakpoints, step-through, watch variables)
- Command output parsing/visualization beyond what the terminal provides
- Command history/recall UI
- Environment variable configuration per command
- Complex command chaining/pipelines

## Decisions

### Split Button in TabBar (D4, D5)

**Decision:** Use a split button (primary action + dropdown) in the editor tab bar next to file names, following VS Code's pattern.

**Rationale:** VS Code's research showed split buttons are superior for multiple actions - one click for the default, dropdown for alternatives. This handles the common case of multiple run targets (dev, test, build) while keeping quick access to the most-used command.

**Alternatives considered:**
- Simple button with dropdown only: Rejected because it requires two clicks even for the most common action
- Separate run and debug buttons: Rejected because Floo doesn't have debugger integration

### Configuration in .project-settings.json (D3)

**Decision:** Add `run` field to ProjectSettings as `HashMap<String, String>` (command name → shell command), following the existing `verify` field pattern.

**Rationale:** Floo already uses this pattern for project-specific configuration. Adding `run` follows the same structure and keeps configuration version-controlled with the project.

**Alternatives considered:**
- Separate run configuration file: Rejected to avoid config file proliferation
- Global user-level configuration: Rejected because run commands are project-specific

### Terminal IPC Command (D13)

**Decision:** Add IPC command to write commands to the terminal PTY, registered in lib.rs with TypeScript wrapper in api.ts.

**Rationale:** The terminal already has PTY write functionality via `terminal.rs`. Adding IPC access allows the frontend to trigger command execution without building new infrastructure.

**Alternatives considered:**
- Direct terminal access from frontend: Rejected due to Tauri security model
- New command execution service: Rejected as unnecessary complexity

### No-Config Onboarding (D12)

**Decision:** When no run configuration exists, show the run button and help users create a simple "run current file" configuration on first click, rather than hiding the button.

**Rationale:** Hiding the button makes the feature undiscoverable. JetBrains auto-creates configurations from context, and this approach provides similar discoverability while keeping configuration explicit.

**Alternatives considered:**
- Hide button when no config: Rejected due to poor discoverability
- Auto-create config without user input: Rejected because users should control their configurations

## Risks / Trade-offs

### TabBar Layout Crowding

**Risk:** Adding a run button to the tab bar could crowd the UI, especially with many open files or long file names.

**Mitigation:** Use a compact button design with Mantine ActionIcon, place it strategically in the tab bar layout, and consider hiding it when the tab bar is very crowded.

### Terminal Focus Confusion

**Risk:** Users might be confused about which terminal the command runs in if multiple terminals are open.

**Mitigation:** Always use the project's primary terminal pane (the one managed by TerminalPane.tsx) for run commands. Add visual feedback showing which terminal is active.

### Configuration Complexity

**Risk:** Users might not understand how to configure run commands in `.project-settings.json`.

**Mitigation:** Provide clear onboarding flow when no config exists, with sensible defaults for common languages (e.g., `npm run dev` for Node.js projects). Consider adding a settings UI in the future if needed.

## Migration Plan

No migration required - this is a new capability. Existing projects work unchanged (run button appears but has no configuration until users add one). The `.project-settings.json` format change is backward compatible due to the `#[serde(default)]` attribute on the new field.
