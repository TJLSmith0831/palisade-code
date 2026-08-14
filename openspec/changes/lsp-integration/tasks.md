## 1. Rust LSP server process management and WebSocket bridge (riskiest first)

- [ ] 1.1 Write failing Rust test: LSP server process spawns successfully with stdio transport (RED)
- [ ] 1.2 Write failing Rust test: LSP server process terminates cleanly on Drop (RED)
- [ ] 1.3 Write failing Rust test: WebSocket message translates to LSP stdio format with Content-Length headers (RED)
- [ ] 1.4 Write failing Rust test: LSP stdio output translates to WebSocket messages (strips Content-Length headers) (RED)
- [ ] 1.5 Create new Rust module `src-tauri/src/lsp.rs` with LSP server spawning via stdio
- [ ] 1.6 Implement WebSocket bridge using Tauri WebSocket plugin for LSP communication
- [ ] 1.7 Add LSP stdio protocol translation (Content-Length header handling)
- [ ] 1.8 Implement dynamic port allocation for multiple concurrent LSP servers
- [ ] 1.9 Run `cargo test lsp::` to verify LSP module tests pass
- [ ] 1.10 Test with real LSP server (e.g., typescript-language-server) to verify end-to-end communication

## 2. LSP configuration in ProjectSettings

- [ ] 2.1 Write failing Rust test: ProjectSettings with LSP config round-trips through serde (RED)
- [ ] 2.2 Write failing Rust test: ProjectSettings without LSP config still loads (backward compat) (RED)
- [ ] 2.3 Add `LspOverride` struct to `src-tauri/src/settings.rs` with `enabled: Option<bool>` and `server_path: Option<String>`
- [ ] 2.4 Add `lsp: HashMap<String, LspOverride>` field to `ProjectSettings` struct
- [ ] 2.5 Update `.project-settings.json` default contents to include empty `lsp` field
- [ ] 2.6 Run `cargo test settings::` to verify settings tests pass
- [ ] 2.7 Test manual editing of LSP config in `.project-settings.json` to verify it loads correctly

## 3. LSP IPC commands in Rust backend

- [ ] 3.1 Write failing Rust test: `start_lsp_server` IPC command spawns server and returns port (RED)
- [ ] 3.2 Write failing Rust test: `stop_lsp_server` IPC command terminates server process (RED)
- [ ] 3.3 Write failing Rust test: `get_lsp_status` IPC command returns server status (running/stopped) (RED)
- [ ] 3.4 Add `start_lsp_server` command to `src-tauri/src/lib.rs` with project hash, language, and file path parameters
- [ ] 3.5 Add `stop_lsp_server` command to terminate LSP servers for a project/language
- [ ] 3.6 Add `get_lsp_status` command to query LSP server status
- [ ] 3.7 Add LSP commands to `generate_handler!` registry in `src-tauri/src/lib.rs`
- [ ] 3.8 Run `cargo test lib::` to verify IPC command tests pass
- [ ] 3.9 Test LSP commands via Tauri devtools to verify they work end-to-end

## 4. TypeScript API wrappers for LSP commands

- [ ] 4.1 Write failing TS test: `api.startLspServer` calls the correct IPC command with parameters (RED)
- [ ] 4.2 Write failing TS test: `api.stopLspServer` calls the correct IPC command (RED)
- [ ] 4.3 Write failing TS test: `api.getLspStatus` calls the correct IPC command and returns status (RED)
- [ ] 4.4 Add `startLspServer` function to `src/api.ts` with proper TypeScript types
- [ ] 4.5 Add `stopLspServer` function to `src/api.ts`
- [ ] 4.6 Add `getLspStatus` function to `src/api.ts`
- [ ] 4.7 Run relevant TS test file to verify API wrapper tests pass

## 5. Tauri WebSocket plugin installation and setup

- [ ] 5.1 Add Tauri WebSocket plugin to `src-tauri/Cargo.toml` dependencies
- [ ] 5.2 Add `@tauri-apps/plugin-websocket` to frontend dependencies in `package.json`
- [ ] 5.3 Register WebSocket plugin in `src-tauri/src/main.rs` or `lib.rs`
- [ ] 5.4 Configure WebSocket plugin permissions in `capabilities/default.json`
- [ ] 5.5 Test WebSocket connection with a simple echo server to verify plugin works

## 6. @codemirror/lsp-client dependency and setup

- [ ] 6.1 Add `@codemirror/lsp-client` to frontend dependencies in `package.json`
- [ ] 6.2 Create simple WebSocket transport implementation for @codemirror/lsp-client
- [ ] 6.3 Test transport with a mock WebSocket server to verify send/receive works

## 7. LSP client integration in FileEditorPane

- [ ] 7.1 Write failing TS test: LSP client initializes when LSP server is available (RED)
- [ ] 7.2 Write failing TS test: LSP client connects to WebSocket bridge on file open (RED)
- [ ] 7.3 Write failing TS test: LSP client disconnects on file close or project switch (RED)
- [ ] 7.4 Add @codemirror/lsp-client extensions to CodeMirror editor setup in `FileEditorPane.tsx`
- [ ] 7.5 Implement LSP client initialization with language-specific configuration
- [ ] 7.6 Wire LSP client to WebSocket transport using Tauri WebSocket plugin
- [ ] 7.7 Add LSP client lifecycle management (connect on file open, disconnect on close)
- [ ] 7.8 Run relevant TS test file to verify FileEditorPane LSP integration tests pass

## 8. LSP server auto-detection from PATH

- [ ] 8.1 Write failing Rust test: LSP server detection finds `typescript-language-server` on PATH (RED)
- [ ] 8.2 Write failing Rust test: LSP server detection returns None when server not found (RED)
- [ ] 8.3 Implement PATH detection logic in `src-tauri/src/lsp.rs` for common LSP servers
- [ ] 8.4 Add language-to-server-binary mapping (e.g., typescript → typescript-language-server)
- [ ] 8.5 Run `cargo test lsp::` to verify detection tests pass
- [ ] 8.6 Test auto-detection with real LSP server installations

## 9. Per-language-per-project LSP server lifecycle

- [ ] 9.1 Write failing Rust test: Switching files within same project keeps LSP servers running (RED)
- [ [ ] 9.2 Write failing Rust test: Switching projects shuts down all LSP servers (RED)
- [ ] 9.3 Implement LSP server registry tracking active servers per project per language
- [ ] 9.4 Add project switch handler to clean up LSP servers for previous project
- [ ] 9.5 Run `cargo test lsp::` to verify lifecycle tests pass
- [ ] 9.6 Test lifecycle by switching between files and projects manually

## 10. LSP server crash handling and restart logic

- [ ] 10.1 Write failing Rust test: Crashed LSP server is restarted once (RED)
- [ ] 10.2 Write failing Rust test: LSP server disabled after 3 crashes in short window (RED)
- [ ] 10.3 Implement crash detection and restart logic with exponential backoff
- [ ] 10.4 Add crash counter and disable logic for failing language servers
- [ ] 10.5 Integrate crash logging with harness warnings system
- [ ] 10.6 Run `cargo test lsp::` to verify crash handling tests pass
- [ ] 10.7 Test crash handling by manually killing LSP servers

## 11. Go-to-definition feature implementation

- [ ] 11.1 Write failing TS test: Go-to-definition keyboard shortcut triggers LSP request (RED)
- [ ] 11.2 Write failing TS test: Go-to-definition navigates to correct file and line on success (RED)
- [ ] 11.3 Add go-to-definition keybinding to CodeMirror editor in `FileEditorPane.tsx`
- [ ] 11.4 Wire go-to-definition to LSP client's textDocument/definition request
- [ ] 11.5 Implement file navigation to LSP-returned location
- [ ] 11.6 Run relevant TS test file to verify go-to-definition tests pass
- [ ] 11.7 Test go-to-definition manually with real LSP server

## 12. Hover tooltips feature implementation

- [ ] 12.1 Write failing TS test: Hovering over symbol displays LSP tooltip (RED)
- [ ] 12.2 Write failing TS test: Hover tooltip dismisses on cursor move or Escape (RED)
- [ ] 12.3 Enable hover tooltips in @codemirror/lsp-client configuration
- [ ] 12.4 Add hover tooltip styling using Mantine components
- [ ] 12.5 Run relevant TS test file to verify hover tooltip tests pass
- [ ] 12.6 Test hover tooltips manually with real LSP server

## 13. Diagnostics display implementation

- [ ] 13.1 Write failing TS test: LSP diagnostics display as underlines in editor (RED)
- [ ] 13.2 Write failing TS test: Diagnostic details show on hover (RED)
- [ ] 13.3 Enable diagnostics in @codemirror/lsp-client configuration
- [ ] 13.4 Add diagnostic indicator styling (red for errors, yellow for warnings)
- [ ] 13.5 Implement diagnostic details tooltip on hover
- [ ] 13.6 Run relevant TS test file to verify diagnostics tests pass
- [ ] 13.7 Test diagnostics manually with code that has LSP-reported errors

## 14. Semantic autocomplete implementation

- [ ] 14.1 Write failing TS test: Semantic autocomplete suggestions appear when LSP server active (RED)
- [ ] 14.2 Write failing TS test: Autocomplete falls back to word/symbol when LSP unavailable (RED)
- [ ] 14.3 Enable semantic completion in @codemirror/lsp-client configuration
- [ ] 14.4 Configure autocomplete to prefer LSP suggestions over basic word/symbol
- [ ] 14.5 Run relevant TS test file to verify autocomplete tests pass
- [ ] 14.6 Test semantic autocomplete manually with real LSP server

## 15. Multi-language LSP server support

- [ ] 15.1 Write failing Rust test: Different languages use different LSP servers (RED)
- [ ] 15.2 Write failing Rust test: Language detection maps file extensions to correct LSP servers (RED)
- [ ] 15.3 Implement language detection from file extensions in `src-tauri/src/lsp.rs`
- [ ] 15.4 Add comprehensive language-to-LSP-server mapping (TS/JS, Python, Rust, Go, Java, C++, PHP, HTML, CSS, JSON, SQL, Markdown, YAML, XML)
- [ ] 15.5 Run `cargo test lsp::` to verify multi-language tests pass
- [ ] 15.6 Test with files of different languages to verify correct LSP servers are used

## 16. End-to-end verification and testing

- [ ] 16.1 Manual test: Open TypeScript file with typescript-language-server installed, verify go-to-definition works
- [ ] 16.2 Manual test: Open Python file with pylsp installed, verify hover tooltips work
- [ ] 16.3 Manual test: Open Rust file with rust-analyzer installed, verify diagnostics work
- [ ] 16.4 Manual test: Switch between TypeScript and Python files, verify both LSP servers stay running
- [ ] 16.5 Manual test: Switch projects, verify LSP servers are cleaned up
- [ ] 16.6 Manual test: Kill LSP server process, verify it restarts automatically
- [ ] 16.7 Manual test: Open file without LSP server installed, verify graceful degradation to syntax highlighting
- [ ] 16.8 Manual test: Configure LSP override in `.project-settings.json`, verify it's respected
- [ ] 16.9 Run full frontend test suite: `pnpm test`
- [ ] 16.10 Run full Rust test suite: `cd src-tauri && cargo test`
- [ ] 16.11 Run Tauri dev build: `pnpm start` and verify no startup errors
