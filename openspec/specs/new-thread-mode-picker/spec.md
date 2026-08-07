# new-thread-mode-picker Specification

## Purpose

Gives new threads an explicit, understood starting mode via an inline Vibe/Spec choice instead of silently defaulting to one, while leaving the existing two-mode system unchanged.

## Requirements

### Requirement: New Thread opens an inline picker
Activating "+ New Thread" SHALL NOT immediately create a thread; it SHALL instead render an inline picker with two choices, "Vibe" and "Spec", inside the chat surface rather than a modal dialog.

#### Scenario: Clicking New Thread shows the picker
- **WHEN** the user clicks "+ New Thread"
- **THEN** the chat surface shows two picker cards labeled "Vibe" and "Spec" instead of an active thread

### Requirement: Picker choice seeds the thread's mode
Selecting "Vibe" SHALL create a thread and set its mode to `go`; selecting "Spec" SHALL create a thread and set its mode to `spec`. No third mode value SHALL be introduced.

#### Scenario: Picking Vibe seeds go mode
- **WHEN** the user selects the "Vibe" card
- **THEN** a new thread is created and its mode is set to `go`, using the existing `setThreadMode` mechanism

#### Scenario: Picking Spec seeds spec mode
- **WHEN** the user selects the "Spec" card
- **THEN** a new thread is created and its mode is set to `spec`

### Requirement: Mode remains changeable after creation
After a thread is created via the picker, its mode SHALL remain changeable through the existing composer Spec/Go toggle, unchanged by this capability.

#### Scenario: Switching mode after picker creation
- **WHEN** a thread created via the "Vibe" picker choice is active
- **THEN** the composer's Spec/Go toggle still allows switching that thread to `spec` mode
