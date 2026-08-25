## Purpose

Lets a user or an agent-driven workflow see a running local URL (typically a dev server) inline in the IDE, without switching to an external browser.

**Done when**: a user can open the Preview tab manually (via "+" → "New Preview") and via agent-driven auto-detection, and both paths work identically in Vibe mode and Editor mode.

## ADDED Requirements

### Requirement: Preview tab available next to chat in both shell modes
The system SHALL let the user open a Preview tab in the center column (alongside file/spec/table/query/chain tabs), positioned directly adjacent to the chat panel, available identically whether the center shell is in Vibe mode or Editor mode.

#### Scenario: Opening a Preview tab manually
- **WHEN** the user clicks the "+" button in the tab bar and selects "New Preview" from the dropdown
- **THEN** a Preview tab opens (or an existing one is focused), showing a URL bar and (if a URL is loaded) the loaded page, next to the chat panel

#### Scenario: Available regardless of shell mode
- **WHEN** the center shell is switched between Vibe and Editor
- **THEN** the Preview tab affordance remains present and functions identically in both

### Requirement: Manual URL navigation
The system SHALL let the user type or edit a URL in the Preview panel's URL bar and load it.

#### Scenario: User navigates to a URL
- **WHEN** the user types a URL into the Preview panel's URL bar and submits it
- **THEN** the panel loads and displays that URL

### Requirement: Reload current page
The system SHALL let the user reload the currently loaded URL without retyping it.

#### Scenario: User reloads
- **WHEN** the user clicks the reload control
- **THEN** the panel re-fetches and re-displays the currently loaded URL

### Requirement: Always-available external open
The system SHALL always offer a control that opens the Preview panel's current URL in the system's default external browser, regardless of whether the page is loading successfully inside the panel.

#### Scenario: Opening externally
- **WHEN** the user clicks "open externally" with a URL loaded in the Preview panel
- **THEN** that URL opens in the system's default browser

#### Scenario: Available even when the page fails to render inline
- **WHEN** the loaded URL fails to render inside the Preview panel (e.g. the page refuses to be framed)
- **THEN** the "open externally" control is still present and usable

### Requirement: Load-failure hint
The system SHALL show a passive hint suggesting the external-open control if the Preview panel's content does not visibly change within a short time after navigating.

#### Scenario: Page never renders
- **WHEN** the user navigates the Preview panel to a URL and no visible content change occurs within the load timeout
- **THEN** the system displays a hint pointing at the external-open control

#### Scenario: Page renders normally
- **WHEN** the user navigates the Preview panel to a URL that renders successfully
- **THEN** no failure hint is shown

### Requirement: Auto-open on detected dev-server URL
The system SHALL detect a local dev-server URL (localhost/127.0.0.1) printed by either a human-run terminal command or an agent-run tool call, and automatically open a Preview tab navigated to it, switching to that tab immediately.

#### Scenario: Human starts a dev server in the terminal
- **WHEN** a command run in the integrated terminal prints a localhost URL (e.g. `Local: http://localhost:5173`)
- **THEN** a Preview tab opens (or the existing one navigates), becomes the active tab, and shows that URL next to the chat panel

#### Scenario: Agent starts a dev server via a tool call
- **WHEN** an agent (Claude Code, Codex, or any other ACP agent) runs a shell tool call whose output prints a localhost URL
- **THEN** a Preview tab opens (or the existing one navigates), becomes the active tab, and shows that URL next to the chat panel, with no agent-specific code required

#### Scenario: No dev-server URL printed
- **WHEN** a run command or agent tool call produces no localhost URL in its output
- **THEN** no Preview tab is opened or navigated

#### Scenario: Repeated identical URL doesn't steal focus again
- **WHEN** the same localhost URL that is already loaded in a Preview tab is printed again (e.g. a repeated HMR reconnect banner)
- **THEN** the system does not re-navigate or switch tabs again
