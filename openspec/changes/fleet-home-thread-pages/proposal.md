## Why

Chat, the thread list and the editor could all be closed at once, leaving a
blank canvas with one 32px chevron, and the shell had no clear hierarchy
between Fleet and a thread. One hierarchy fixes both: **Fleet → a thread →
Review**, with the sidebar as Fleet's quick access from inside a thread.

## What Changes

- Fleet stays home. Opening a row opens that thread: chat plus the editor pane.
- A `← Fleet` button in the top bar returns to Fleet. Cmd+K is bound to it.
- Chat can no longer be closed. Editor and terminal stay as toggles.
- The Chat toggle and the collapsed chat strip are removed.
- The Threads toggle is renamed **Agent Access** (icon-only, tooltip): it shows and hides the sidebar,
  which is the compact Fleet (same rows, grouped by status) for jumping between
  threads without leaving the page. `← Fleet` and Agent Access share one pill.
- A new thread started outside Fleet (tab-strip `+`, palette) still shows the
  "How do you want to start?" Go/Spec card.

## Not Changing

The sidebar itself (search, grouping, rename/archive), the open-thread tab
strip, the Fleet composer, Review, the History rail, the Workbench rail
(works from Fleet as it does today), Spec/Go modes, and all Rust code.
