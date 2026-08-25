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

