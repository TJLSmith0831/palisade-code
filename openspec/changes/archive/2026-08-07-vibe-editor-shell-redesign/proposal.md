## Why

Chat currently has no stable home: an earlier pass merged it inline into the right Threads panel, which made that rail too cramped to work in and gave up Codebase Map access with no replacement. Separately, the UI has never exposed a way to switch executor/model or toggle permission-bypass, and starting a new thread silently defaults to a mode with no visible choice or explanation. This change gives the workspace two purpose-built shells — a chat-centric Vibe shell and a code-centric Editor shell — switchable from the top chrome, restores an accessible thread-mode picker, and exposes executor/model/bypass controls for the first time.

## What Changes

- Add a persistent **Vibe | Editor** toggle in the top chrome, directly right of the traffic lights, that switches the whole workspace shell. This is independent of a thread's own Spec/Go mode — it does not replace or duplicate the existing composer mode toggle.
- **Vibe shell**: chat is the main/primary column (not a tab); a dedicated "Edited Files" column shows diffs and any files opened from the tree; the file tree collapses into a disclosure in the right rail; Codebase Map is not available in this shell.
- **Editor shell**: restores the classic file-tree-left + Editor/Diff-tabs-center layout. The right rail keeps chat, with Threads and Codebase Map merged into one collapsible disclosure (closed by default) so chat gets the rail's full height when idle.
- Replace silent "+ New Thread" creation with an inline **Vibe/Spec picker** rendered in the chat surface itself (not a modal dialog) that seeds the new thread's mode. The underlying two-mode system (`spec` | `go`) is unchanged — this is a friendlier front door onto it, not a third mode.
- **BREAKING**: Remove the standalone `/propose` button from the chat header. `/propose` remains available as a slash command in the composer, which already special-cases it.
- Add a top-chrome menu showing the auto-detected executor (read-only, per the project's "detection, not config" rule) alongside a user-selectable model picker and a bypass-permissions toggle — none of which were exposed in the UI before.
- Guarantee: from anywhere in either shell, a past thread, creating a new thread, and the Codebase Map are each reachable within 3 clicks.

## Capabilities

### New Capabilities
- `workspace-shell-toggle`: the top-chrome Vibe/Editor control and the two distinct shell layouts it switches between.
- `new-thread-mode-picker`: the inline Vibe/Spec picker shown on new-thread creation, and how it seeds a thread's mode.
- `editor-collapsible-rail`: the Editor shell's right rail — chat plus a collapsible Threads & Codebase Map disclosure — and the 3-click reachability guarantee.
- `executor-model-switcher`: the top-chrome executor/model picker and bypass-permissions toggle.

### Modified Capabilities
<!-- none — no existing archived spec covers thread/chat placement, shell layout, or executor selection -->

## Impact

- `src/App.tsx`: top-chrome toggle and executor/model/bypass controls; shell-switching state; new-thread picker replacing direct `api.createThread` calls; removal of the `/propose` button; Editor-shell right-rail disclosure.
- `src/App.css`: new component classes for the shell toggle, model/bypass menu, inline mode-picker cards, and the collapsible Threads & Codebase Map disclosure.
- `src/api.ts`: no `Mode` type change (`"spec" | "go"` stays as-is); `setThreadMode` continues to be the mechanism the picker calls after `createThread`.
- `src/__tests__/App.test.tsx`: coverage for the shell toggle, both shells' chat placement, the new-thread picker (both branches), and the 3-click reachability of threads/new-thread/codemap in the Editor shell.
- No backend/Rust changes — this is a frontend layout and interaction change only.
