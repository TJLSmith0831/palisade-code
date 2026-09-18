## REMOVED Requirements

### Requirement: Persistent shell toggle in top chrome
**Reason**: The Vibe/Editor mode toggle is removed by the ADE pivot (`ade-pivot`); the shell no longer distinguishes a chat-centric mode from a code-centric mode. The fleet board is now the default landing view, and Workbench tools (editor, terminal, run/debug, database, notebooks, preview) are reached from the rail and from diff/explorer file clicks instead of a shell-wide toggle.
**Migration**: No user data migration. Users who previously left the toggle on Editor lose nothing — every Workbench tool the Editor shell exposed remains reachable, just demoted to a rail group instead of a top-chrome mode switch.

### Requirement: Toggle switches the workspace shell
**Reason**: Same as above — there is no longer a separate Vibe/Editor shell to switch between.
**Migration**: None; see the removed toggle requirement above.

### Requirement: Shell toggle is independent of thread mode
**Reason**: The toggle it describes no longer exists. Thread mode (`spec` | `go`) is unaffected by this change and continues to be governed by its own capability, not by this one.
**Migration**: None.

### Requirement: Vibe shell has no Codebase Map surface
**Reason**: There is no longer a Vibe shell to scope this requirement to, and Codebase Map (Graphify) is removed entirely by a separate, parallel change.
**Migration**: None.

## ADDED Requirements

### Requirement: Workbench tools remain one click away from any thread
The system SHALL keep the editor, terminal, run/debug, database, notebooks, and preview tools reachable from the navigation rail's Workbench group and from any diff or file-explorer click, without requiring a shell-wide mode switch.

#### Scenario: Opening a file from a diff
- **WHEN** the user clicks a file in a thread's diff
- **THEN** the system opens that file in the editor without switching the whole workspace into a different shell mode

#### Scenario: Reaching the terminal from the rail
- **WHEN** the user selects Terminal in the Workbench group of the navigation rail
- **THEN** the integrated terminal opens for the active project, with the fleet board, review lane, and other primary views still reachable from the rail
