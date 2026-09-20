## ADDED Requirements

### Requirement: A thread is a page inside Fleet
Opening a thread from the Fleet board SHALL show that thread's chat beside the editor pane, with a control that returns to Fleet. The Agent Access sidebar SHALL offer the same threads in compact form so the user can move between them without returning to Fleet.

#### Scenario: Opening and leaving a thread
- **WHEN** the user opens a thread from a Fleet row and then activates the back control
- **THEN** the thread's chat is shown, then the Fleet board is shown again

#### Scenario: Switching without leaving
- **WHEN** the user picks another thread in Agent Access
- **THEN** that thread's chat is shown and the Fleet board is not

### Requirement: Chat cannot be closed
The shell SHALL always show the chat pane while a thread page is open. Editor and terminal panes MAY be toggled; chat MAY NOT, and a previously saved collapsed state SHALL be ignored.

#### Scenario: Editor closed
- **WHEN** the user closes the editor pane on a thread page
- **THEN** the chat pane remains visible and the canvas is never empty

### Requirement: Back to Fleet is one chord
The Mod+K chord SHALL return to the Fleet board from a thread page.

#### Scenario: Chord from a thread
- **WHEN** the user presses Mod+K on a thread page
- **THEN** the Fleet board is shown
