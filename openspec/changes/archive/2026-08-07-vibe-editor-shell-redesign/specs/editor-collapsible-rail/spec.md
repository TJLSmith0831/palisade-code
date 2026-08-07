## Purpose

Keeps chat available in the Editor shell's right rail without permanently competing with the thread list and Codebase Map for space, while guaranteeing fast access to both.

## ADDED Requirements

### Requirement: Threads and Codebase Map share one collapsible disclosure
In the Editor shell, the right rail SHALL present Threads and Codebase Map inside a single collapsible disclosure, collapsed by default, separate from the chat area below it.

#### Scenario: Rail defaults to collapsed
- **WHEN** the Editor shell renders for the first time in a session
- **THEN** the Threads & Codebase Map disclosure is collapsed and the chat area occupies the remaining rail height

### Requirement: Chat reclaims height when the disclosure is collapsed
Collapsing the Threads & Codebase Map disclosure SHALL expand the chat area (messages and composer) to fill the remaining vertical space of the right rail.

#### Scenario: Collapsing after expansion
- **WHEN** the user collapses an expanded Threads & Codebase Map disclosure
- **THEN** the chat area's height increases to fill the space the disclosure previously occupied

### Requirement: Selecting a thread collapses the disclosure
Selecting a thread from the expanded Threads list SHALL collapse the disclosure automatically, returning focus to the chat area for that thread.

#### Scenario: Picking a thread from the open list
- **WHEN** the user opens the disclosure and clicks a thread row
- **THEN** the disclosure collapses and the chat area shows the selected thread's messages and composer

### Requirement: Past threads, new thread, and Codebase Map are each reachable within 3 clicks
From any point in the Editor shell, selecting a past thread, creating a new thread, and opening Codebase Map SHALL each require no more than 3 clicks.

#### Scenario: Reaching a past thread
- **WHEN** the user is in the Editor shell with the disclosure collapsed
- **THEN** opening the disclosure (1 click) and selecting a thread row (1 click) reaches that thread in 2 clicks

#### Scenario: Reaching Codebase Map from the Vibe shell
- **WHEN** the user is in the Vibe shell, which has no Codebase Map surface of its own
- **THEN** switching to the Editor shell (1 click), opening the disclosure (1 click), and selecting the Codebase Map tab (1 click) reaches it in 3 clicks
