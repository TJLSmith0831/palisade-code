# Explore: embedded browser for live previews

Goal: preview a running dev server (or other local URL) inside Palisade
without switching to Chrome/Safari.

## Context gathered

- Palisade is Tauri 2 + WKWebView (not Electron, not Chromium) — see
  [CLAUDE.md](../../CLAUDE.md) gotcha: "No headless mode. Playwright can't
  drive this... Use the Tauri MCP against the debug-only bridge on
  `127.0.0.1:9223`."
- `Cargo.toml` currently declares plain `tauri = { version = "2", features = [] }`
  — no multiwebview/child-webview feature enabled yet.
- Panes today (`src/App.tsx`) are all React components inside the single
  webview: `FileEditorPane`, `DiffPane`, `GraphPane`, `TerminalPane`,
  `McpPane`, `VerifyPane`, `ProblemsPane`, etc. No existing iframe or child
  webview usage found anywhere in `src/*.tsx` or `src-tauri/src/*.rs`.
- `.palisade/project-settings.json` already has a `run` field
  (`src-tauri/src/settings.rs`) — named shell commands like
  `{"dev": "pnpm start"}` that the title bar split button / rail Run panel
  execute.
- In-flight change `run-debug-buttons` (0/57 tasks) adds a run button in the
  editor tab bar that executes `run` commands **in the terminal pane** and
  focuses it. This is the natural trigger point for "run dev server, then
  show me the page."
- No existing spec, change, or explore note covers an embedded browser or
  preview pane — clear of prior art/conflicts.

## Decisions

### D1: Render approach — iframe vs native child webview
- **Decision**: Render via a plain `<iframe>` in the existing React pane tree, not a native Tauri child webview.
- **Why**: Feature scope is previewing your own running dev server (localhost), not general web browsing. Every comparable code-tool (VS Code Live Preview/Simple Browser, bolt.new, v0, StackBlitz, Replit) uses an iframe for exactly this case — child webviews are only justified when the product's job is browsing arbitrary third-party sites (Arc, Wavebox). Iframe needs zero new Cargo features or Rust IPC surface; a child webview would need both with no prior art in this codebase.
- **Source**: user

### D2: Placement/trigger — standalone pane + run-command tie-in
- **Decision**: Ship a standalone "Preview" pane with its own URL bar (open/navigate independent of anything else), and separately let a `run` command optionally auto-populate/open it with a detected URL.
- **Why**: The address-bar pane is useful on its own even when there's no run command running; the auto-populate path removes the extra click for the common case of "I just started my dev server."
- **Source**: user

### D4: Pane chrome — URL bar, reload, open-externally
- **Decision**: Editable URL bar (serves D2's manual-entry path), a reload button, and an "open in external browser" escape hatch for when iframe embedding fails (D1's known frame-blocking limitation). No back/forward navigation history.
- **Why**: Dev-server previews are mostly single-page reloads, not multi-page browsing sessions — back/forward tracking iframe nav history adds complexity with little payoff for this use case. The external-browser escape hatch covers D1's accepted risk (some servers send X-Frame-Options/CSP frame-ancestors) without needing the iframe approach to be bulletproof.
- **Source**: user

### D3: URL detection for auto-open — scrape terminal output
- **Decision**: Watch PTY output from a running `run` command for a localhost/127.0.0.1 URL pattern (e.g. `Local: http://localhost:5173`) and auto-open the Preview pane to it. No new config field.
- **Why**: Zero-config for the common case (Vite/Next/CRA and most dev servers print this on startup). Explicit `previewUrl` config would always be correct but breaks the existing `run: HashMap<String,String>` shape in settings.rs and requires per-project hand-configuration. Silent failure (no auto-open, user pastes URL manually) is an acceptable fallback for nonstandard servers.
- **Source**: user

### D5: Implementation surface for URL scraping — frontend-only
- **Decision**: Do the URL-pattern scrape in the frontend, listening to the existing `terminal-output` event (`terminal_cmds.rs:42`, base64-encoded PTY bytes already consumed by `TerminalPane.tsx`). No new Rust/IPC surface for detection.
- **Why**: The terminal is already a single global PTY per project (`terminal_spawn`'s "single terminal instance" doc comment) whose full output stream is already emitted app-wide — nothing needs to change on the Rust side to observe it.
- **Source**: codebase (`src-tauri/src/commands/terminal_cmds.rs:42`, `src/TerminalPane.tsx:73`)

### D6: "Open in external browser" — reuse `@tauri-apps/plugin-opener`
- **Decision**: Use the already-installed, already-registered `tauri-plugin-opener` (`Cargo.toml:23`, `lib.rs:2335`) and its JS `openUrl()` (`@tauri-apps/plugin-opener` in `package.json:37`) for D4's escape hatch. No new Rust command.
- **Why**: Plugin is already wired end-to-end and unused anywhere in the app — this is the textbook already-installed-dependency case.
- **Source**: codebase (`src-tauri/Cargo.toml:23`, `src-tauri/src/lib.rs:2335`, `package.json:37`)

### D7: Pane location — left-rail panel, not bottom tab
- **Decision**: Add `"preview"` to `PANEL_IDS` (`useAppShell.ts:19`), giving it a full icon-rail entry and pane area, rather than extending `BottomTab`.
- **Why**: A live page needs real screen area to be useful, not the cramped bottom strip shared with terminal/problems.
- **Source**: user

### D8: Failure handling — no detection, timeout hint only
- **Decision**: The "open externally" button is always visible, not conditional on detecting a failure (WKWebView gives no JS signal for X-Frame-Options/CSP frame-ancestors blocks). After a short load timeout with no visible change, show a passive hint ("Not loading? Open externally.") pointing at the always-present button.
- **Why**: Framing failures are silent by design in WKWebView — there's no reliable programmatic detection to build against, so the UI doesn't pretend to detect it.
- **Source**: user

### D9: Agent-driven dev servers must also auto-open Preview
- **Decision**: Apply the same URL-detection regex (D3/D5) to `ExecutorEvent::ToolResult.output` (`executor.rs:134`), not just `terminal-output`. Whichever stream prints a localhost URL first opens the panel — covers a human running `pnpm dev` in the terminal and an agent running it as a Bash tool call, uniformly.
- **Why**: Agent shell tool calls (Claude Code/Codex via ACP) flow through `executor-event`, a separate stream from the PTY terminal — without this, a dev server the agent itself starts would silently not trigger auto-open, defeating the point for agent-driven workflows.
- **Source**: user

### D10: No new agent-facing protocol for explicit "open this URL" — passive detection only
- **Decision**: Considered and rejected giving agents an explicit way to command "open this URL in Preview now" (e.g. a special output marker or new ACP tool convention). Sticking with passive regex detection over both streams (D9) as the only trigger.
- **Why**: Palisade's agents are discovered at runtime with no per-agent parser and no `KNOWN_AGENTS` table (CLAUDE.md gotcha) — a bespoke "agent signals the UI" protocol would require every agent CLI's cooperation and invents new ACP surface with no prior art (only `PermissionRequest` exists today, and that's agent-CLI-protocol-native, not Palisade-invented). Passive detection works identically regardless of which agent is running, with zero new surface.
- **Source**: user


### D11: Auto-detect switches active panel immediately
- **Decision**: When a dev-server URL is auto-detected (D3/D9), the Preview panel becomes the active rail panel immediately, matching `run-debug-buttons`' existing pattern of focusing the terminal pane on command execution.
- **Why**: Consistency with the established pattern in this codebase; user confirmed this over a quiet-background-load alternative.
- **Source**: user

### D12: Placement pivot — center-column tab, not left-rail panel (supersedes D7)
- **Decision**: Preview is NOT a `PANEL_IDS` left-rail entry (D7 is superseded). It's a new `PreviewTab` variant in the existing `OpenTab` discriminated union (`openTabs.ts:53` — file/spec/table/query/chain), rendered by the shared `TabBar`/`ds-main` center column, directly adjacent to `ds-chat-rail` (chat, which docks on the right — `App.tsx:4780`).
- **Why**: User asked to match how vibe-coding tools (bolt.new, v0, Lovable, Replit Agent) lay this out — live preview docked immediately next to the chat/agent conversation, always visible together, not behind an icon-rail click on the opposite side of the screen. Palisade's left-rail side panel (`ds-side-panel`) sits far from `ds-chat-rail`, so D7's placement didn't match that pattern. The `OpenTab` union is also the more lazy/reuse-consistent fit (ponytail rung 2: already-in-codebase pattern) versus inventing a new toggle.
- **Source**: user

### D13: Manual-open trigger — "+" button in TabBar
- **Decision**: Add a small "+"/new-preview icon button to `TabBar` itself that opens a new (or focuses the existing) Preview tab with an empty URL bar.
- **Why**: Preview no longer has a rail panel to open it from (D12). Self-contained to the component already being touched; more discoverable than a command-palette-only entry point for a feature the proposal frames as a primary workflow.
- **Source**: user

### D14: "+" button opens a dropdown (New File / New Preview), not preview-only
- **Decision**: The `TabBar` "+" button (D13) opens a small dropdown menu with two items: "New File" and "New Preview" — standard IDE pattern (VS Code, Zed), not a preview-specific button. "New File" creates a file at the project root; "New Preview" opens/focuses the singleton Preview tab (D12/D13).
- **Amended during implementation**: the original plan — lift `FileTree.tsx`'s `openCreate`/`runCreate` into a shared callback — does not work. `FileTree` is only mounted while the Explorer side panel is active (`App.tsx:4181`), and its naming UI is an inline input node inside the tree itself, so the tab bar cannot drive it (and in Vibe mode the tree isn't on screen at all). Instead, "New File" reuses the app's existing `kind: "input"` prompt bar (`App.tsx`, the same modal `onCloneRepository` and the note-name flow already use), then writes the file via `api.writeFileContent(hash, name, "")` — the same call `runCreate` makes — refreshes the tree cache, and opens the new file in a tab. The explorer's own per-folder "New File" is unchanged.
- **Why**: User confirmed this is the standard pattern and wants "+" to cover both, not be preview-only. Modal chosen over auto-naming (`untitled-N`) so the tab bar's create flow names files the same way the explorer's does.
- **Source**: user

### D15: Definition of done — both trigger paths, both shell modes
- **Decision**: The change is done when a user can open the Preview tab (a) manually via the "+" → "New Preview" path and (b) via agent-driven auto-detection (D9), and both work identically whether the center shell is in Vibe mode or Editor mode. This is a proposal-level acceptance statement, not a new requirement — it names the combination already implied by D12 (availability in both shells) and D9 (both detection streams) as the explicit release bar.
- **Why**: User wants this combination called out explicitly as "done," not left implicit across separate requirements — this is the primary agent-driven-workflow value proposition from proposal.md's Why, so it's the bar that must be manually verified before the change ships.
- **Source**: user

### D16: "+" menu also offers New Chain
- **Decision**: The `TabBar` "+" dropdown carries three items — New File, New Preview, New Chain — the last opening a blank chain tab (`openChain(null)`, the same entry point the chains sidebar uses).
- **Why**: User asked for it while reviewing the live menu. A chain is already a first-class `OpenTab` variant with an existing "new, unsaved" state (`chain:new`), so this is one menu item and one existing callback, not new machinery.
- **Source**: user

### D17: Terminal detection scans a settled buffer, not every chunk
- **Decision**: The `terminal-output` listener debounces (250ms of quiet) and strips ANSI escapes before matching, rather than running the regex on every chunk. The agent (`toolResult`) path is unchanged — each result is already a complete string.
- **Why**: Found in live testing. A shell's line editor repaints the command you typed using cursor escapes (`\r`, `ESC[K`), so mid-burst the buffer literally contains `http://127.0.0.1:44` on the way to `…:4402/`. That truncated string is a *different* URL, so it passed D11's dedup, navigated the pane to a bogus port, and stole focus every time the same command was re-run. Scanning only settled output matches the finished line and makes D11's "same URL doesn't re-trigger" actually hold.
- **Source**: codebase (`src/useDevServerPreview.ts`, verified against real PTY bytes in the running app)
