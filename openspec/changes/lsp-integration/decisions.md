# LSP Integration Decision Log

## D1: Should LSP and run/debug be separate changes or combined?

- **Decision**: Separate changes - LSP integration first, run/debug buttons second
- **Why**: LSP integration is a foundational editor capability that affects the entire codebase (editor extensions, IPC commands, settings). Run/debug buttons are UI workflow enhancements that can build on top of a working editor. Separating them allows for independent testing, validation, and rollout.
- **Source**: grill-explore

## D2: What LSP client approach should we use for CodeMirror 6?

- **Decision**: Use `@codemirror/lsp-client` (v6.2.5) as the LSP client library
- **Why**: This is the official, actively-maintained CodeMirror LSP client with comprehensive feature support (autocompletion, hover tooltips, signature hints, go-to-definition, diagnostics, rename, reformatting). It's MIT-licensed, actively maintained (latest release June 2026), and already proven in production by Spacebar Editor, YCode, and other Tauri + CodeMirror projects.
- **Source**: grill-explore

## D3: How should LSP servers be managed (spawned, lifecycle, transport)?

- **Decision**: Rust backend manages LSP server processes via stdio transport, frontend uses WebSocket bridge to communicate
- **Why**: Palisade already has Rust process management patterns (executor, terminal, Graphify watcher). Managing LSP servers in Rust gives us proper lifecycle control, environment isolation, and integration with existing project settings. The frontend can't directly spawn processes due to Tauri security model. WebSocket bridge (similar to Tauri MCP bridge pattern) allows the frontend LSP client to talk to Rust-managed servers.
- **Source**: grill-explore

## D4: Which LSP servers should we support initially?

- **Decision**: Support all languages that have both CodeMirror language packages and mature LSP servers (TypeScript/JavaScript, Python, Rust, Go, Java, C++, PHP, HTML, CSS, JSON, SQL, Markdown, YAML, XML, etc.)
- **Why**: CodeMirror has language packages for 20+ languages, and the LSP ecosystem has 400+ servers. Restricting to 3 is arbitrary when the architecture can handle many more. The system should detect and use whatever LSP server is available for the current file's language, following the same pattern as executor detection - user installs the language server, Palisade finds and uses it.
- **Source**: user feedback, web research (CodeMirror language packages, LSP ecosystem)

## D5: Where should LSP configuration live (project vs user level)?

- **Decision**: Auto-detect LSP servers from PATH by default (no configuration required), optional overrides in `.project-settings.json` only for custom paths or disabling specific languages
- **Why**: Palisade already uses this pattern for executor detection - auto-detect from PATH, optional override in settings. LSP should work the same way: user installs typescript-language-server, Palisade finds it and uses it. Configuration only needed for edge cases (non-standard install paths, disabling LSP for specific languages). This avoids the painful LSP setup experience in other editors.
- **Source**: user feedback, codebase analysis (executor detection pattern)

## D6: What should be the non-goals for LSP integration?

- **Decision**: No debugger protocol (DAP), no LSP server installation management, no full extension ecosystem
- **Why**: Traditional debugging (breakpoints, step-through, watch variables) requires DAP integration which is a separate complex system beyond the scope of adding basic IDE pieces. LSP server installation should be user-managed (npm install, pip install, cargo install) - Palisade should detect and use, not manage. Full extension ecosystem (like VS Code) is out of scope - Palisade is an agent harness, not a general-purpose IDE platform.
- **Source**: grill-explore

## D7: How does this relate to the existing code-editor spec?

- **Decision**: This change extends the existing code-editor spec with LSP capabilities, not a replacement
- **Why**: The existing `code-editor` spec already covers CodeMirror 6 integration, syntax highlighting, and FIM completion. LSP integration is an additive capability that builds on that foundation. This should be a new spec (`lsp-integration`) that extends the current editor surface.
- **Source**: grill-explore

## D8: Why implement LSP integration now? What's the timing driver?

- **Decision**: Competitive parity and user expectation - modern IDEs have LSP-powered features as table stakes
- **Why**: Palisade's current editor has basic syntax highlighting but lacks semantic understanding (go-to-definition, hover tooltips, diagnostics) that users expect from modern IDEs. The timing is right because the CodeMirror 6 foundation is solid and we have process management patterns in place to handle LSP servers gracefully.
- **Source**: recommended-accepted

## D9: Who benefits from LSP integration and what's the primary user-facing impact?

- **Decision**: Developers working in TypeScript/JavaScript, Python, and Rust who use Palisade as their daily editor
- **Why**: The impact is threefold: (1) Navigation - go-to-definition and find-references make codebase exploration faster, (2) Quality - real-time diagnostics catch errors before running, (3) Velocity - semantic autocomplete and hover tooltips reduce context-switching to documentation. This makes Palisade feel like a "real" IDE rather than just an agent interface with a basic code viewer.
- **Source**: recommended-accepted

## D10: What's the explicit scope boundary for this change - what's definitively in vs out?

- **Decision**: IN - LSP server process management (spawn, lifecycle, stdio transport), WebSocket bridge for frontend communication, @codemirror/lsp-client integration with the editor, configuration in .project-settings.json, support for all languages with both CodeMirror packages and mature LSP servers. OUT - LSP server installation/management UI, custom LSP protocol extensions, workspace-level multi-root LSP support, performance optimization beyond basic functionality, niche languages without mature LSP servers.
- **Why**: This supports the broad language ecosystem while keeping the architecture focused on proving the core LSP integration works. The system should detect and use whatever LSP server is available for the current file's language, following the same pattern as executor detection.
- **Source**: recommended-accepted

## D11: What does "done" look like for this change - how will we know LSP integration is working?

- **Decision**: Done means: (1) User can open supported language files and see LSP features working (go-to-definition, hover tooltips, diagnostics), (2) LSP server process management is correct (spawns on file open, shuts down on project switch, no process leaks), (3) .project-settings.json configuration is respected (enable/disable per language, custom server paths), (4) Graceful degradation for missing LSP servers (warning + basic syntax highlighting, no crash).
- **Why**: This covers the core user experience plus system reliability aspects. The definition is concrete and testable - we can verify each criterion with manual testing or automated tests.
- **Source**: recommended-accepted

## D12: What approach should we use for the WebSocket bridge between Rust and the frontend LSP client?

- **Decision**: Use Tauri WebSocket plugin (@tauri-apps/plugin-websocket) with a simple Rust WebSocket bridge that spawns LSP servers via stdio, translates between WebSocket messages and LSP stdio protocol (Content-Length headers), and uses dynamic port allocation for multiple concurrent servers
- **Why**: The @codemirror/lsp-client package has a Transport interface that works with WebSocket connections, and there are proven examples (skript-studio, unison-editor) using this pattern in Tauri apps. The Tauri WebSocket plugin gives us battle-tested WebSocket handling for free. The rejected alternative is building a custom bridge from scratch.
- **Source**: web research (Tauri WebSocket plugin, @codemirror/lsp-client transport examples, skript-studio, unison-editor), recommended-accepted

## D13: What should the minimal LSP configuration look like in `.project-settings.json` given auto-detection?

- **Decision**: Add minimal `lsp` field to ProjectSettings as `HashMap<String, LspOverride>` where key is language identifier and value is simple struct with `enabled: Option<bool>` (None = auto-detect, Some(false) = disabled, Some(true) = force enable) and `server_path: Option<String>` (custom binary path, null = PATH detection)
- **Why**: Default case (no config) means "auto-detect everything from PATH" - zero configuration for normal users. Overrides only for edge cases (non-standard install paths, disabling LSP for specific languages). This follows Palisade's executor detection pattern and avoids painful LSP setup.
- **Source**: recommended-accepted

## D14: What should happen when an LSP server crashes or becomes unresponsive?

- **Decision**: Handle gracefully: (1) Log crash in harness warnings system, (2) Auto-restart server up to 3 times with exponential backoff, (3) After 3 crashes in short window, disable LSP for that language for current session and show user-facing warning, (4) Editor continues with basic syntax highlighting (no crash)
- **Why**: Balances resilience with avoiding infinite restart loops that could hang the editor. This follows Palisade's existing process failure handling patterns and ensures the editor remains functional even when LSP fails.
- **Source**: recommended-accepted

## D15: What should happen when switching between files of different languages in the same project?

- **Decision**: Keep LSP servers running per language per project - switching from .ts to .py doesn't shut down TypeScript LSP, just activates Python LSP if not already running. Servers shut down when switching projects entirely, not when switching files within a project.
- **Why**: Provides faster switching (no startup latency) and handles common case of working with multiple languages in one project. This is similar to how IDEs like VS Code handle multiple language servers per workspace.
- **Source**: recommended-accepted

## D16: What are the key integration points for LSP integration in the existing codebase?

- **Decision**: Main integration points: (1) FileEditorPane.tsx - add @codemirror/lsp-client extensions to CodeMirror setup, (2) New Rust module src-tauri/src/lsp.rs - LSP server process management and WebSocket bridge, (3) src-tauri/src/lib.rs - add IPC commands for LSP operations, (4) src-tauri/src/settings.rs - add LSP configuration to ProjectSettings, (5) src/api.ts - add TypeScript wrappers for LSP IPC commands
- **Why**: Follows Palisade's existing pattern of new Rust module → lib.rs IPC → api.ts wrapper → frontend usage. This covers all touch points needed for end-to-end LSP functionality.
- **Source**: codebase analysis, recommended-accepted

## D17: What's the riskiest part of this change that we should tackle first?

- **Decision**: Riskiest part is Rust LSP server process management and WebSocket bridge (new lsp.rs module) because it involves process spawning, stdio communication, and WebSocket protocol handling - areas where bugs can cause hangs or crashes. It's the foundation everything else builds on.
- **Why**: Process lifecycle bugs (leaked processes, zombie processes) are particularly hard to debug. We should implement and test this with a single LSP server (e.g., typescript-language-server) before expanding to multiple languages.
- **Source**: recommended-accepted

## D12 revision — Tauri IPC transport instead of a WebSocket bridge

**Decision (implementation, shell-redesign Phase 4):** the frontend talks to
the Rust-managed language servers over Tauri's existing command + event
channel (`lsp_send` / `lsp-message`), not over a WebSocket bridge.

**Rationale:** D12 chose WebSockets because "the frontend can't spawn
processes due to Tauri security". That premise is unchanged and still
correct — the servers are still spawned and owned by Rust
(`src-tauri/src/lsp.rs`). What changed is the observation that
`@codemirror/lsp-client`'s `Transport` is three methods
(`send`/`subscribe`/`unsubscribe`), which the existing IPC channel already
satisfies. Adding a WebSocket server would introduce dynamic port
allocation, a second framing layer and a second transport to keep alive —
three of the five risks D12's own risk list names — to reach the same
interface. Content-Length framing on the servers' stdio is still handled in
Rust, which is where it belongs.

**Unchanged by this:** server lifecycle (D15, per language per project),
detection (D5/D13, PATH only), failure handling (D14, restart ×3 with
backoff then disable), and language coverage (D4).

**Verified live** (2026-08-14, Tauri MCP against a debug build): a real
`typescript-language-server` initialized and published diagnostics into the
Problems tab; a deliberately broken `rust-analyzer` shim produced
crash → restart(1/3) → crash → restart(2/3) → crash → disabled, each state
visible in the editor status bar, with syntax highlighting intact
throughout.

> > > > > > > shell-redesign-and-mvp-finalization
