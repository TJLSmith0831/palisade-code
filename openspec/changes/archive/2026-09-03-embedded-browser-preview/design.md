## Context

See proposal.md — Why. Key constraints from the codebase (decisions.md D1–D13):

- Panes are React components inside one WKWebView; no iframe or child-webview precedent exists.
- Two independent output streams can carry a dev-server startup URL: `terminal-output` (human-run PTY, base64-encoded chunks, `terminal_cmds.rs:42`) and `executor-event` carrying `ExecutorEvent::ToolCall`/`ToolResult` (agent-run Bash tool calls, `executor.rs:134`).
- `ds-main`'s center column already renders a discriminated-union tab system, `OpenTab` (`openTabs.ts:53`: file/spec/table/query/chain), through one shared `TabBar`. Chat docks permanently on the right as `ds-chat-rail` (`App.tsx:4780`), so any tab in `ds-main` already sits directly beside it — no new layout primitive needed to satisfy D12 (preview next to chat).
- `@tauri-apps/plugin-opener` is installed and registered but unused.

## Goals / Non-Goals

**Goals:**
- One `PreviewTab` variant on the existing `OpenTab` union, one `PreviewPane.tsx` renderer, one shared URL-detection utility reused by both stream listeners.
- Preview sits next to chat (`ds-chat-rail`) whenever it's open, in both Vibe and Editor mode, matching the bolt.new/v0/Replit-style docked-preview pattern (D12).
- Auto-detection works identically regardless of whether a human or any ACP agent produced the output.

**Non-Goals:**
- No native child webview / multiwebview — out per D1.
- No `PANEL_IDS`/left-rail entry for Preview — superseded by D12.
- No navigation history (back/forward) — out per D4.
- No new Tauri command or Rust code — everything here is observable from the frontend already.
- No new agent-facing protocol for agents to explicitly request a preview — out per D10.
- No persistence of the loaded URL across app restarts or project switches — it lives in component/tab state and resets like the terminal does on project switch (D5's "single terminal instance" precedent), consistent with how other ephemeral tab-local view state isn't persisted to `.palisade/project-settings.json`.

## Decisions

### PreviewTab shape and tab identity
`PreviewTab = { type: "preview"; url: string | null; dirty: false; mdPreview: false }`, added to the `OpenTab` union in `openTabs.ts`. `tabKey` returns the constant `"preview"` — one singleton Preview tab, not one per URL, matching D2's original "standalone pane you navigate" intent rather than a multi-tab browser (consistent with D4's no-back/forward, single-page-reload framing). Opening a second time (via the "+" button, D13, or another auto-detected URL) reuses/renavigates the existing tab and switches to it, the same as clicking an already-open file tab refocuses rather than duplicates it.

### "+" button — dropdown with New File / New Preview
A new icon button added to `TabBar.tsx`, near the existing tab strip (exact position TBD at implementation — after the last tab is the obvious default). Clicking it opens a small dropdown (Mantine `Menu`, already used elsewhere in the codebase) with two items:
- **New Preview**: opens/focuses the singleton Preview tab (D12) with an empty URL bar if no URL is loaded yet, or the current one if already open.
- **New File**: creates a file at the project root. `FileTree.tsx`'s `openCreate`/`runCreate` (`FileTree.tsx:267`) can't be reused directly — `FileTree` only mounts while the Explorer side panel is active (`App.tsx:4181`) and its naming UI is an inline input *inside the tree*, so the tab bar has nothing to drive (D14, amended). Instead `App.tsx` reuses its existing `setBar({ kind: "input" })` name prompt, which writes the file with `api.writeFileContent(hash, name, "")` — the same call `runCreate` makes — invalidates the file-tree cache, and opens the file in a tab. No folder picker, no change to the explorer's existing per-folder "New File" behavior.

### Shared URL-detection utility
A single function, e.g. `detectDevServerUrl(text: string): string | null`, matches `https?://(localhost|127\.0\.0\.1)(:\d+)?[^\s"'<>]*` and returns the last match (dev servers sometimes print both an IPv4 and IPv6/network URL; last-match favors the more specific one printed after "Local:" in Vite/Next's typical output order — verify against a couple of real dev-server banners during implementation and adjust if the first match is actually the right one).

Two call sites:
- **Terminal**: a small hook (`useDevServerPreview`) subscribes to `terminal-output`, base64-decodes each chunk, and appends to a small rolling buffer (a few KB, trimmed). It matches only once the burst settles (250ms quiet) and after stripping ANSI escapes (D17) — a URL can straddle two PTY chunks, and a shell's line-editor redraw puts a half-drawn URL in the buffer that would otherwise read as a distinct URL and defeat the dedup below.
- **Agent tool calls**: subscribes to `executor-event`, filters for `ExecutorEvent::ToolResult`, and matches directly against `output` — each `ToolResult` is already a complete string, no buffering needed.

Alternative considered: do the regex match in Rust and emit a dedicated `preview-url-detected` event. Rejected — would add IPC surface for a change proposal.md commits to needing none of (D5), and the frontend already receives full text on both existing streams.

### Dedup / re-trigger behavior
Track the last auto-navigated URL in the Preview tab's state. A newly detected URL only triggers navigation (and the tab-switch, D11) if it differs from the last one — otherwise chatty dev-server output (e.g. HMR reconnect logs repeating the same "Local:" banner) would repeatedly steal focus.

### Load-failure timeout
A fixed timeout (short — implementation detail, not a spec-level contract; a `ponytail:` comment should mark the chosen value as a guess to tune later) starts on navigation. If the iframe's `onLoad` hasn't fired by then, show the hint. `onLoad` firing is not proof of success (a framed-but-blocked page can still fire `load` for an empty/error document in some cases), so this is a best-effort heuristic per D8, not a guarantee.

## Risks / Trade-offs

- **Regex false positives**: tool-call output or terminal output containing a localhost URL that isn't actually a dev server banner (e.g. an agent `curl`-ing a local URL, or printing one in a log message) would wrongly auto-navigate and steal focus (D11). Mitigation: none planned initially — acceptable given D9's requirement is "best effort, zero-config"; revisit with a stricter pattern (e.g. requiring a "Local:"/"ready on"/"listening on" prefix) if false positives prove common in practice.
- **Iframe framing failures are silent** (accepted risk, D1/D8) — mitigated only by the always-visible external-open button and the timeout hint, not by detection.
- **Rolling terminal buffer** could theoretically miss a URL split across an unusually large gap between chunks if the buffer is trimmed too aggressively — mitigation: size the buffer generously (a few KB) relative to typical single-line startup banners.

## Migration Plan

None — purely additive (new panel, new capability, no changes to existing data shapes or commands).
