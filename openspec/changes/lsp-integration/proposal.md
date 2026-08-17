## Why

Palisade's current editor has basic syntax highlighting but lacks semantic understanding (go-to-definition, hover tooltips, diagnostics) that users expect from modern IDEs. The timing is right because the CodeMirror 6 foundation is solid and we have process management patterns in place to handle LSP servers gracefully. (D8)

## What Changes

- Add LSP server process management (spawn, lifecycle, stdio transport) in a new Rust module `src-tauri/src/lsp.rs`
- Implement WebSocket bridge using Tauri WebSocket plugin (@tauri-apps/plugin-websocket) for frontend-LSP server communication (D12)
- Integrate @codemirror/lsp-client (v6.2.5) with the CodeMirror editor in `FileEditorPane.tsx` (D2)
- Add LSP configuration to `.project-settings.json` with auto-detection from PATH by default (D5, D13)
- Support all languages that have both CodeMirror language packages and mature LSP servers (TS/JS, Python, Rust, Go, Java, C++, PHP, HTML, CSS, JSON, SQL, Markdown, YAML, XML, etc.) (D4)
- Add IPC commands in `src-tauri/src/lib.rs` for LSP operations (start_server, stop_server, get_status) (D16)
- Add TypeScript wrappers in `src/api.ts` for LSP IPC commands (D16)

## Capabilities

### New Capabilities

- `lsp-integration`: Language Server Protocol integration for the CodeMirror editor, providing semantic features like go-to-definition, hover tooltips, diagnostics, and semantic autocomplete across multiple programming languages.

### Modified Capabilities

- `code-editor`: Extend existing CodeMirror 6 editor with LSP capabilities (D7)

## Impact

**Affected code:**
- New Rust module: `src-tauri/src/lsp.rs` (LSP process management and WebSocket bridge)
- Modified: `src-tauri/src/lib.rs` (IPC commands), `src-tauri/src/settings.rs` (ProjectSettings), `src/FileEditorPane.tsx` (editor extensions), `src/api.ts` (TypeScript wrappers)

**New dependencies:**
- `@codemirror/lsp-client` (v6.2.5) for CodeMirror LSP client
- `@tauri-apps/plugin-websocket` for WebSocket communication
- Tauri WebSocket plugin in Rust

**Systems:**
- LSP servers are auto-detected from PATH (user installs them, Palisade finds them) - no installation management UI (D6)
- LSP servers run per language per project, shut down on project switch (D15)
- Graceful degradation when LSP servers are missing or crash (D11, D14)
