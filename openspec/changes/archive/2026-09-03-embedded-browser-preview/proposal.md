## Why

Seeing a running dev server today means switching to Chrome/Safari, which breaks flow and loses the IDE's context (panes, layout, focus). Palisade already runs dev servers via `.palisade/project-settings.json`'s `run` commands (in-flight `run-debug-buttons` change) but has no way to show the result inline. This matters especially for agent-driven ("vibe") workflows, where the standard pattern (bolt.new, v0, Lovable, Replit Agent) is a live preview docked directly beside the chat, updating as the agent works.

## What Changes

- Add a "Preview" tab kind to the center-column tab system (the existing `OpenTab` union: file/spec/table/query/chain, rendered by `TabBar`/`ds-main`), with an editable URL bar, reload button, and an always-visible "open in external browser" button. This puts it directly beside `ds-chat-rail` (chat, which docks on the right), matching how vibe-coding tools lay out chat + live preview.
- A small "+" button in `TabBar` opens a dropdown with "New File", "New Preview", and "New Chain" (standard IDE pattern, D16) — "New Preview" opens/focuses the singleton Preview tab manually; "New File" prompts for a name in the app's existing input prompt and creates the file at the project root (D14, amended — `FileTree`'s inline naming input can't be driven from the tab bar since the tree only mounts with the Explorer panel open).
- The panel renders the entered URL in an `<iframe>` — no native child webview.
- Watch two existing event streams in the frontend for a `localhost`/`127.0.0.1` URL pattern — `terminal-output` (human-run commands) and `ExecutorEvent::ToolResult` output (agent-run Bash tool calls) — and auto-open/navigate a Preview tab to whichever prints one first, switching to it immediately. This makes the panel work identically whether a human or an agent (Claude Code, Codex, or any future ACP agent) starts the dev server, with no per-agent code and no new agent-facing protocol.
- No back/forward navigation history; no programmatic detection of iframe framing failures (WKWebView gives no reliable signal for this) — instead, a passive "Not loading? Open externally." hint appears after a short load timeout.

## Done when

A user can open the Preview tab both ways — manually via "+" → "New Preview", and automatically via a detected dev-server URL from either a human terminal command or an agent tool call — and both paths work identically whether the center shell is in Vibe mode or Editor mode.

## Capabilities

### New Capabilities
- `preview-pane`: an in-app browser tab for previewing a local URL (typically a dev server) via iframe, with manual URL entry and auto-open from detected `run`-command or agent tool-call output.

### Modified Capabilities
(none — no existing spec's requirements change)

## Impact

- **Frontend**: new `PreviewTab` variant added to the `OpenTab` union (`src/openTabs.ts`) and a `PreviewPane.tsx` renderer wired into `ds-main`'s tab switch; a "+" dropdown (New File / New Preview) added to `TabBar.tsx`, with "New File" reusing `App.tsx`'s existing name-prompt bar; listeners on both `terminal-output` (new, alongside the existing one in `TerminalPane.tsx`) and `executor-event`'s `ToolResult` variant scan for dev-server URLs; `@tauri-apps/plugin-opener`'s `openUrl()` wired for the external-browser button.
- **Backend**: none — no new Tauri commands, no new Cargo dependencies. `terminal-output` and `tauri-plugin-opener` are both already wired end-to-end and unused for this purpose.
- **No changes** to `.palisade/project-settings.json`'s `run` field shape, PTY/terminal backend, `PANEL_IDS`, or any existing spec.
