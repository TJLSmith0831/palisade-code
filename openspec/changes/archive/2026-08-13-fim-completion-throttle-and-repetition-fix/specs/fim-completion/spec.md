## MODIFIED Requirements

### Requirement: Inline ghost text completion

The system SHALL display AI-generated code completions as greyed inline ghost text at the cursor position in the code editor, with a configurable keybinding (default: Option+Tab) to accept the suggestion into the document. The accept keybinding SHALL only trigger when ghost text is visible. Completions SHALL fire after a 1250ms trailing-edge debounce (no typing for 1.25 seconds), not on every micro-pause.

#### Scenario: Ghost text appears after typing pause

- **WHEN** user types in the code editor and pauses for 1250ms
- **THEN** the system displays greyed ghost text showing the predicted completion at the cursor position

#### Scenario: Accept completion with Option+Tab

- **WHEN** ghost text is displayed and user presses Option+Tab (or the configured accept keybinding)
- **THEN** the system inserts the ghost text into the document at the cursor position

#### Scenario: Accept keybinding does nothing without ghost text

- **WHEN** no ghost text is displayed and user presses the accept keybinding
- **THEN** the system performs no action (the keybinding is conditional on ghost text presence)

#### Scenario: Dismiss completion with Escape

- **WHEN** ghost text is displayed and user presses Escape
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Dismiss completion on cursor movement

- **WHEN** ghost text is displayed and user moves the cursor away from the completion position
- **THEN** the system removes the ghost text without inserting any text

#### Scenario: Cancel in-flight request on new keystroke

- **WHEN** a completion request is in-flight and user types another character
- **THEN** the system marks the in-flight request as aborted and drops its result when it returns, then starts a new completion request after the debounce period

### Requirement: FIM completion request format

The system SHALL send fill-in-the-middle completion requests to the local inference server with prefix (text before cursor), suffix (text after cursor), and cursor position, respecting the token budget (256 prefix tokens, 128 suffix tokens, 128 max generation tokens). The request SHALL include `repeat_penalty: 1.1` and `top_p: 0.95` to prevent repetition traps, with `temperature: 0.0` for deterministic output.

#### Scenario: Completion request with prefix and suffix

- **WHEN** the system requests a completion
- **THEN** it sends the prefix (up to 256 tokens), suffix (up to 128 tokens), cursor position, `n_predict: 128`, `repeat_penalty: 1.1`, `top_p: 0.95`, and `temperature: 0.0` to the inference server

#### Scenario: Completion response includes latency tracking

- **WHEN** the inference server returns a completion
- **THEN** the response includes the completion text and model latency in milliseconds for telemetry

## ADDED Requirements

### Requirement: Completion post-processing preserves indentation

The system SHALL preserve leading whitespace (indentation) in all lines of a completion. The keyword-dedup post-processing (removing `from from` / `importimport` / `import import` duplicates) SHALL operate on line content without stripping or normalizing indentation. This matches the Continue.dev reference implementation, which separates dedup from indent normalization and only performs the former.

#### Scenario: Multi-line completion preserves indentation on all lines

- **WHEN** the model returns a multi-line completion with leading whitespace on lines after the first
- **THEN** the system preserves that whitespace in the ghost text without stripping or normalizing it

#### Scenario: Keyword dedup still works without stripping indent

- **WHEN** the model returns a completion with a duplicate keyword (e.g., `from from fastmcp` or `importimport pandas`)
- **THEN** the system removes the duplicate keyword while preserving any leading indentation on that line

#### Scenario: First-line indentation is preserved

- **WHEN** the model returns a completion whose first line has leading whitespace
- **THEN** the system preserves that leading whitespace without collapsing it via whitespace normalization
