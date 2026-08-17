# IDE Run/Debug Buttons and LSP Support

Exploration for adding missing IDE pieces to Palisade Code: run/debug buttons and LSP integration.

## D1: Should LSP and run/debug be separate changes or combined?

- **Decision**: Separate changes - LSP integration first, run/debug buttons second
- **Why**: LSP integration is a foundational editor capability that affects the entire codebase (editor extensions, IPC commands, settings). Run/debug buttons are UI workflow enhancements that can build on top of a working editor. Separating them allows for independent testing, validation, and rollout.
- **Source**: recommended-accepted

## D2: What LSP client approach should we use for CodeMirror 6?

- **Decision**: Use `@codemirror/lsp-client` (v6.2.5) as the LSP client library
- **Why**: This is the official, actively-maintained CodeMirror LSP client with comprehensive feature support (autocompletion, hover tooltips, signature hints, go-to-definition, diagnostics, rename, reformatting). It's MIT-licensed, actively maintained (latest release June 2026), and already proven in production by Spacebar Editor, YCode, and other Tauri + CodeMirror projects.
- **Source**: web research (codemirror/lsp-client GitHub, npm package, Spacebar Editor, YCode)

## D3: How should LSP servers be managed (spawned, lifecycle, transport)?

- **Decision**: Rust backend manages LSP server processes via stdio transport, frontend uses WebSocket bridge to communicate
- **Why**: Palisade already has Rust process management patterns (executor, terminal, Graphify watcher). Managing LSP servers in Rust gives us proper lifecycle control, environment isolation, and integration with existing project settings. The frontend can't directly spawn processes due to Tauri security model. WebSocket bridge (similar to Tauri MCP bridge pattern) allows the frontend LSP client to talk to Rust-managed servers.
- **Source**: codebase analysis (terminal.rs, integrations.rs, executor.rs), web research (Tauri IPC patterns, @codemirror/lsp-client transport options)

## D4: Which LSP servers should we support initially?

- **Decision**: Start with TypeScript/JavaScript (typescript-language-server), Python (pylsp), and Rust (rust-analyzer) as MVP
- **Why**: These three cover the vast majority of Palisade's likely use cases (web dev, scripting, systems programming). All three have mature, well-maintained LSP servers that are commonly available via npm/pip/cargo. This MVP validates the architecture without over-engineering support for dozens of niche languages.
- **Source**: recommended-accepted (based on typical IDE usage patterns and Palisade's target audience)

## D5: Where should LSP configuration live (project vs user level)?

- **Decision**: LSP server configuration in `.project-settings.json` (project-level), server binary detection in PATH (user-level)
- **Why**: Palisade already uses `.project-settings.json` for project-specific configuration (format-on-save, verify commands, executor override). Adding LSP server settings there keeps project-specific language server choices with the project. Binary detection via PATH follows the same pattern as executor detection - user installs the language server, Palisade finds it. This avoids managing LSP server installations and keeps the harness lightweight.
- **Source**: codebase analysis (settings.rs, executor.rs), recommended-accepted

## D6: What should the run/debug button actually do in Palisade's context?

- **Decision**: Run button executes configured commands in the terminal pane, not traditional debugger attachment
- **Why**: Palisade is an agent harness, not a traditional debugger. The terminal pane already exists and can run commands. Traditional debugging (breakpoints, step-through) would require debugger protocol adapters (DAP) which is a separate complex system. The run button should be a shortcut to run common project commands (dev server, tests, build) in the existing terminal, similar to Replit's run button or JetBrains' npm script configurations.
- **Source**: codebase analysis (TerminalPane.tsx, settings.rs verify commands), web research (Replit workflows, JetBrains npm configurations)

## D7: How should run commands be configured and stored?

- **Decision**: Extend `.project-settings.json` with a `run` field (HashMap<String, String>) similar to existing `verify` field
- **Why**: Palisade already has the pattern in place with `verify` commands. Adding a `run` field follows the same structure: command name → shell command. This keeps project-specific run commands with the project, version-controlled, and discoverable. The UI can present these as a dropdown or split-button similar to VS Code's run/debug patterns.
- **Source**: codebase analysis (settings.rs ProjectSettings struct), web research (VS Code launch.json patterns, Replit .replit file)

## D8: Where should the run button be placed in the UI?

- **Decision**: Run button in the editor tab bar (next to file name), similar to VS Code's editor title run button
- **Why**: VS Code's pattern places run/debug actions in the editor title bar for contextual access to the current file's run configurations. Palisade already has a tab bar (TabBar.tsx) that shows file names. Adding a run button there provides contextual access without cluttering the main toolbar. This follows the established IDE pattern while fitting Palisade's existing layout.
- **Source**: codebase analysis (TabBar.tsx, App.tsx layout), web research (VS Code editor title run button patterns)

## D9: Should the run button be a split button (run + dropdown) or simple button?

- **Decision**: Split button with primary action and dropdown for alternative commands
- **Why**: VS Code's research showed split buttons are superior for multiple actions - one click for the default, dropdown for alternatives. Palisade's `run` configuration may have multiple commands (dev, test, build). A split button allows quick access to the most-used command while keeping others accessible. This matches the established IDE pattern and handles the common case of multiple run targets.
- **Source**: web research (VS Code split button UX research), recommended-accepted

## D10: What should be the non-goals for this exploration?

- **Decision**: No debugger protocol (DAP), no LSP server installation management, no full extension ecosystem
- **Why**: Traditional debugging (breakpoints, step-through, watch variables) requires DAP integration which is a separate complex system beyond the scope of adding basic IDE pieces. LSP server installation should be user-managed (npm install, pip install, cargo install) - Palisade should detect and use, not manage. Full extension ecosystem (like VS Code) is out of scope - Palisade is an agent harness, not a general-purpose IDE platform.
- **Source**: recommended-accepted (scope bounding based on Palisade's positioning as agent harness)

## D11: How does this relate to the existing code-editor spec?

- **Decision**: This exploration extends the existing code-editor spec with LSP and run capabilities, not a replacement
- **Why**: The existing `code-editor` spec already covers CodeMirror 6 integration, syntax highlighting, and FIM completion. LSP integration and run buttons are additive capabilities that build on that foundation. This should be a new spec (e.g., `lsp-integration` and `run-commands`) or amendments to `code-editor`, not a replacement. The exploration is shaping two potential changes that extend the current editor surface.
- **Source**: codebase analysis (openspec show code-editor), recommended-accepted

## Summary

This exploration has shaped two separate changes:

**Change 1: LSP Integration**

- Use `@codemirror/lsp-client` (v6.2.5) for CodeMirror 6
- Rust backend manages LSP server processes (stdio transport)
- WebSocket bridge for frontend communication
- MVP support: TypeScript/JavaScript (typescript-language-server), Python (pylsp), Rust (rust-analyzer)
- Configuration in `.project-settings.json`, binary detection via PATH
- Extends existing `code-editor` spec

**Change 2: Run/Debug Buttons**

- Run button executes configured commands in terminal pane (not debugger attachment)
- Extend `.project-settings.json` with `run` field (HashMap<String, String>)
- Split button in editor tab bar (primary action + dropdown)
- Commands run in existing TerminalPane
- Follows VS Code and JetBrains patterns

**Non-goals for both changes:**

- No debugger protocol (DAP) integration
- No LSP server installation management
- No full extension ecosystem

The exploration is change-shaped with clear scope, approach, and boundaries. Ready for `/grill-propose` to create detailed proposals for each change.
