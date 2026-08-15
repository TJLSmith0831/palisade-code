## Context

Floo's editor currently uses CodeMirror 6 with basic syntax highlighting and FIM completion. The backend already has process management patterns (executor, terminal, Graphify watcher) that can be extended for LSP servers. The frontend uses Tauri IPC for Rust communication and has existing WebSocket infrastructure via the Tauri MCP bridge pattern.

## Goals / Non-Goals

**Goals:**
- Provide semantic editor features (go-to-definition, hover tooltips, diagnostics, semantic autocomplete) across 20+ programming languages
- Auto-detect LSP servers from PATH with zero configuration for normal users
- Maintain Floo's lightweight approach - no LSP server installation management
- Graceful degradation when LSP servers are missing or crash
- Fast language switching by keeping servers running per language per project

**Non-Goals:**
- Debugger protocol (DAP) integration - traditional debugging is out of scope (D6)
- LSP server installation/management UI - users install servers, Floo detects them (D6)
- Full extension ecosystem - Floo is an agent harness, not a general-purpose IDE platform (D6)
- Workspace-level multi-root LSP support - single project scope for MVP (D10)
- Performance optimization beyond basic functionality (D10)

## Decisions

### LSP Client Library: @codemirror/lsp-client (D2)

**Decision:** Use the official @codemirror/lsp-client (v6.2.5) rather than building a custom LSP client.

**Rationale:** This is the actively-maintained CodeMirror LSP client with comprehensive feature support (autocompletion, hover tooltips, signature hints, go-to-definition, diagnostics, rename, reformatting). It's MIT-licensed, proven in production by Spacebar Editor and YCode, and provides a clean Transport interface for WebSocket communication.

**Alternatives considered:**
- Custom LSP client implementation: Rejected due to complexity and maintenance burden
- Monaco Editor with its LSP client: Rejected because Floo already uses CodeMirror 6

### LSP Server Management: Rust Backend with WebSocket Bridge (D3, D12)

**Decision:** Rust backend manages LSP server processes via stdio transport, frontend uses Tauri WebSocket plugin for communication.

**Rationale:** Floo already has Rust process management patterns (executor, terminal, Graphify watcher). Managing LSP servers in Rust gives proper lifecycle control, environment isolation, and integration with existing project settings. The frontend can't directly spawn processes due to Tauri security. The Tauri WebSocket plugin provides battle-tested WebSocket handling.

**Alternatives considered:**
- Frontend-managed LSP servers via WebAssembly: Rejected because it limits us to WASM-compiled language servers, excluding most mature LSP servers
- Direct stdio from frontend: Rejected due to Tauri security model

### Language Support: All Languages with CodeMirror Packages + Mature LSP Servers (D4)

**Decision:** Support all languages that have both CodeMirror language packages and mature LSP servers (TS/JS, Python, Rust, Go, Java, C++, PHP, HTML, CSS, JSON, SQL, Markdown, YAML, XML, etc.) rather than limiting to 3 languages.

**Rationale:** CodeMirror has language packages for 20+ languages, and the LSP ecosystem has 400+ servers. Restricting to 3 is arbitrary when the architecture can handle many more. The system detects and uses whatever LSP server is available for the current file's language.

**Alternatives considered:**
- MVP with only 3 languages (TS/JS, Python, Rust): Rejected as unnecessarily limiting given the broad ecosystem

### Configuration: Auto-Detect from PATH with Minimal Overrides (D5, D13)

**Decision:** Auto-detect LSP servers from PATH by default (no configuration required), optional overrides in `.project-settings.json` only for custom paths or disabling specific languages.

**Rationale:** Follows Floo's executor detection pattern - user installs the language server, Floo finds it. This avoids the painful LSP setup experience in other editors. Configuration only needed for edge cases (non-standard install paths, disabling LSP for specific languages).

**Data shape:** `HashMap<String, LspOverride>` where key is language identifier and value has `enabled: Option<bool>` (None = auto-detect) and `server_path: Option<String>` (custom binary path).

**Alternatives considered:**
- Full LSP server configuration UI: Rejected as unnecessary complexity that conflicts with Floo's lightweight approach

### LSP Server Lifecycle: Per-Language Per-Project (D15)

**Decision:** Keep LSP servers running per language per project - switching from .ts to .py doesn't shut down TypeScript LSP, just activates Python LSP if not already running. Servers shut down when switching projects entirely.

**Rationale:** Provides faster switching (no startup latency) and handles the common case of working with multiple languages in one project. Similar to how VS Code handles multiple language servers per workspace.

**Alternatives considered:**
- One LSP server at a time, shut down on file switch: Rejected due to startup latency

### Failure Handling: Graceful Degradation with Restart Limits (D14)

**Decision:** Handle LSP server crashes gracefully: (1) Log in harness warnings, (2) Auto-restart up to 3 times with exponential backoff, (3) After 3 crashes, disable LSP for that language for the session and show warning, (4) Editor continues with basic syntax highlighting.

**Rationale:** Balances resilience with avoiding infinite restart loops that could hang the editor. Follows Floo's existing process failure handling patterns.

**Alternatives considered:**
- Infinite restart attempts: Rejected due to risk of hanging the editor
- Single-attempt only: Rejected as too fragile for transient failures

## Risks / Trade-offs

### Process Leaks

**Risk:** LSP server processes might not be cleaned up properly, leading to zombie processes or resource leaks.

**Mitigation:** Follow Floo's existing process management patterns (executor, terminal) which use proper cleanup on Drop. Add explicit process cleanup on project switch and app shutdown. Test with process monitoring tools.

### WebSocket Bridge Complexity

**Risk:** The WebSocket bridge translating between LSP stdio protocol and WebSocket messages could have bugs in protocol handling (Content-Length headers, message framing).

**Mitigation:** Use proven patterns from @codemirror/lsp-client examples (tsserver-ws.js) and existing Tauri projects (skript-studio, unison-editor). Test with multiple LSP servers to ensure protocol compatibility.

### Performance Impact

**Risk:** Running multiple LSP servers per project could consume significant CPU/memory, affecting editor responsiveness.

**Mitigation:** Start with one LSP server per language (not per file), which is the standard pattern. Monitor resource usage during testing. Add LSP server disabling capability if needed.

### LSP Server Compatibility

**Risk:** Different LSP servers may have varying protocol compliance or feature support, leading to inconsistent behavior across languages.

**Mitigation:** Focus on mature, widely-used LSP servers (typescript-language-server, pylsp, rust-analyzer, gopls, etc.) that have good LSP 3.x compliance. Test each supported language server individually.

### Dynamic Port Allocation Conflicts

**Risk:** Multiple LSP servers trying to use the same port could cause conflicts.

**Mitigation:** Use dynamic port allocation with proper port cleanup on server shutdown. Follow Tauri WebSocket plugin patterns for port management.

## Migration Plan

No migration required - this is a new capability. Existing projects will work unchanged (LSP features simply won't activate until language servers are installed on the user's system).

## Open Questions

None - all technical decisions are settled. The spec phase will define the exact requirements for each LSP feature (go-to-definition, hover tooltips, diagnostics, etc.).
