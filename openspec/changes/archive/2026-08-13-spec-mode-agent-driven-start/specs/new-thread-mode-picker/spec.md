## MODIFIED Requirements

### Requirement: New Thread opens an inline picker

Activating "+ New Thread" SHALL NOT immediately create a thread; it SHALL instead render an inline picker with two choices, "Vibe" and "Spec", inside the chat surface rather than a modal dialog.

#### Scenario: Clicking New Thread shows the picker

- **WHEN** the user clicks "+ New Thread"
- **THEN** the chat surface shows two picker cards labeled "Vibe" and "Spec" instead of an active thread

### Requirement: Picker choice defers thread creation to first message

Selecting "Vibe" SHALL NOT immediately create a thread; it SHALL show an empty chat composer in go mode. The thread SHALL be created when the user sends their first message, at which point the thread is created with mode `go` and the message is sent. Selecting "Spec" SHALL NOT immediately create a thread; it SHALL show a spec-type framing menu (see "Spec-type framing menu" requirement). No third mode value SHALL be introduced.

#### Scenario: Picking Vibe shows empty composer, thread created on first send

- **WHEN** the user selects the "Vibe" card
- **THEN** an empty chat composer appears in go mode, no thread is created, and no thread appears in the sidebar
- **WHEN** the user types a message and sends it
- **THEN** a new thread is created with mode `go` and the message is sent as the first turn

#### Scenario: Picking Spec shows the framing menu, thread created on spec-type commit

- **WHEN** the user selects the "Spec" card
- **THEN** a spec-type framing menu appears (Feature / Bugfix / Other), no thread is created, and no thread appears in the sidebar
- **WHEN** the user selects a spec type (or submits custom text for "Other")
- **THEN** a new thread is created with mode `spec`, the spec type is stored on the thread, and `grill-explore` is fired with the spec type as the user turn body

### Requirement: Mode remains changeable after creation

After a thread is created via the picker, its mode SHALL remain changeable through the existing composer Spec/Go toggle, unchanged by this capability.

#### Scenario: Switching mode after picker creation

- **WHEN** a thread created via the "Vibe" picker choice is active
- **THEN** the composer's Spec/Go toggle still allows switching that thread to `spec` mode

## ADDED Requirements

### Requirement: Spec-type framing menu

When the user selects "Spec" from the Vibe/Spec picker, or enters spec mode via the composer Spec/Go toggle on a thread with no open spec change, the system SHALL show an inline spec-type framing menu with three options: "Feature", "Bugfix", and "Other". The menu SHALL be rendered with Mantine components in the chat surface, not as a modal dialog. The agent SHALL NOT run until the user selects a spec type.

#### Scenario: Framing menu appears after picking Spec

- **WHEN** the user picks "Spec" from the Vibe/Spec picker
- **THEN** an inline card row appears with three Mantine cards: "Feature", "Bugfix", and "Other", each with a bold title and one-line description
- **THEN** no agent session is started and no thread is created

#### Scenario: Framing menu appears on composer Spec toggle with no open change

- **WHEN** the user toggles an existing thread to spec mode via the composer Spec/Go toggle and the thread has no open spec change
- **THEN** the inline spec-type framing menu appears in the chat surface

#### Scenario: Framing menu does not appear when a change is already open

- **WHEN** the user enters spec mode on a thread that already has an open spec change
- **THEN** the framing menu does not appear and the mode is set without auto-firing

#### Scenario: Back button returns to Vibe/Spec picker

- **WHEN** the framing menu is visible and the user clicks the Back button
- **THEN** the framing menu is replaced by the Vibe/Spec picker, no thread is created, and no spec type is stored

### Requirement: Spec type becomes the agent's first-turn framing

Selecting "Feature" or "Bugfix" SHALL start `grill-explore` with the selected spec type as the user turn body, replacing the bare `"grill-explore"` literal. Selecting "Other" SHALL reveal a Mantine `TextInput` for custom framing; submitting non-empty text SHALL start `grill-explore` with that text as the user turn body. The injected grill-explore skill content is prepended as before; only the body changes.

#### Scenario: Picking Feature starts grill-explore with Feature framing

- **WHEN** the user selects the "Feature" card
- **THEN** a thread is created with mode `spec`, `spec_type` is set to `"Feature"`, and `grill-explore` is fired with the body `"Feature"` (prepended with the grill-explore skill content)

#### Scenario: Picking Bugfix starts grill-explore with Bugfix framing

- **WHEN** the user selects the "Bugfix" card
- **THEN** a thread is created with mode `spec`, `spec_type` is set to `"Bugfix"`, and `grill-explore` is fired with the body `"Bugfix"`

#### Scenario: Picking Other reveals a text input

- **WHEN** the user selects the "Other" card
- **THEN** a Mantine `TextInput` appears below the three cards with the placeholder "Describe what you'd like to spec out..."
- **THEN** a contextual "or pick a different type" link appears below the input

#### Scenario: Submitting custom Other text starts grill-explore

- **WHEN** the user types non-empty text into the "Other" input and presses Enter
- **THEN** a thread is created with mode `spec`, `spec_type` is set to the typed text, and `grill-explore` is fired with that text as the body

#### Scenario: Empty Other submission is disabled

- **WHEN** the "Other" input is empty or whitespace-only and the user presses Enter
- **THEN** no submission occurs and the user is signaled to describe what they'd like to spec out

#### Scenario: Other text field escape links back to cards

- **WHEN** the user clicks the "or pick a different type" link
- **THEN** the TextInput is hidden and the three spec-type cards are shown again

### Requirement: Spec type persists on the thread

The system SHALL store the selected spec type on the thread as `spec_type: Option<String>`. The spec type SHALL persist across mode switches and app restarts. When re-entering spec mode on a thread with a stored `spec_type` and no open spec change, the system SHALL reuse the stored spec type without re-showing the framing menu. Old thread records without a `spec_type` field SHALL be tolerated (treated as `None`).

#### Scenario: Spec type survives mode switch and re-entry

- **WHEN** a thread has `spec_type` set to `"Feature"` and no open change, and the user switches to go mode then back to spec mode
- **THEN** the framing menu does not appear and the stored `"Feature"` spec type is used for the auto-fired `grill-explore` turn

#### Scenario: Old thread records without spec_type are tolerated

- **WHEN** the system reads a thread record that predates this change and has no `spec_type` field
- **THEN** the `spec_type` is treated as `None` and the thread functions as before

### Requirement: Spec type re-injected on agent handoff

When a new spec-mode session starts via agent handoff (the thread's agent changed and the transcript is rebuilt), and the thread has a stored `spec_type` but no open spec change, the system SHALL re-inject the stored `spec_type` as the first turn body for the new agent. On same-agent restart (full message history reloaded), the system SHALL NOT re-inject — the original first turn is still in the history.

#### Scenario: Handoff re-injects spec type

- **WHEN** a spec-mode thread with `spec_type` set and no open change undergoes an agent handoff
- **THEN** the new agent's first turn body is the stored `spec_type`, prepended with the grill-explore skill content

#### Scenario: Same-agent restart does not re-inject

- **WHEN** a spec-mode thread with `spec_type` set and no open change is restarted with the same agent (app restart)
- **THEN** the full message history is reloaded (including the original first turn with the spec type body) and no additional framing turn is injected

### Requirement: Agent-driven explore-to-propose transition

The system SHALL NOT show a "Proceed to propose" button during the exploring stage. The grill-explore skill SHALL instruct the agent to emit a `[READY_TO_PROPOSE]` marker when exploration is complete and the agent is ready to proceed to proposal. The system SHALL detect this marker in the agent's text output, strip it from the visible message, and auto-fire `grill-propose` via the existing `propose` IPC command. The `propose` command and its `ProposeWatch` machinery SHALL remain unchanged.

#### Scenario: No "Proceed to propose" button is shown

- **WHEN** a thread is in the exploring stage (`stage === "exploring"`) and the agent is not busy
- **THEN** no "Proceed to propose" button is rendered in the chat surface

#### Scenario: Agent emits READY_TO_PROPOSE marker and system auto-fires propose

- **WHEN** the agent's text output contains the `[READY_TO_PROPOSE]` marker
- **THEN** the marker is stripped from the visible message before rendering
- **THEN** the system auto-fires `grill-propose` via the existing `propose` IPC command, injecting the grill-propose skill content as the next user turn

#### Scenario: Marker is not emitted during normal exploration turns

- **WHEN** the agent's text output does NOT contain the `[READY_TO_PROPOSE]` marker
- **THEN** no auto-fire occurs and the user can continue the exploration conversation normally
