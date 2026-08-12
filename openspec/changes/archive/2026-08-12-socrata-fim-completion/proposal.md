## Why

Floo Network currently has basic word autocomplete but lacks AI-powered code completion. The socrata-v1-flash model (fine-tuned Qwen3.5-0.8B for FIM) is validated and performs excellently (67ms TTFT), making this the right time to implement Cursor/Devin Desktop-style inline completion. The user needs to package Floo Network for distribution to other users, requiring the model and inference engine to be bundled in the app rather than stored in user-writable locations. (D27, D28, D12)

## What Changes

- **Bundle model and inference engine**: Package the 540MB Qwen3.5-0.8B.Q4_K_M.gguf model and llama-server binary (~10MB) in the Tauri app bundle using `bundle.resources` and `externalBin` features (D17, D18, D21)
- **Sidecar process management**: Rust backend spawns llama-server at app startup, pointing it to the bundled model, following the terminal.rs pattern for lifecycle management (D3, D4, D19)
- **IPC layer**: New `complete_code` Tauri command following the three-edit pattern (command fn, generate_handler! registration, api.ts wrapper) (D6, D36)
- **CodeMirror ghost text**: Custom ViewPlugin + Decoration extension for inline ghost text with Tab to accept, replacing the current dropdown-only autocomplete (D5)
- **Settings UI**: Add enable/disable toggle and configurable accept keybinding (default: Option+Tab) for completion in settings panel (D22, D40)
- **Telemetry**: Track acceptance rate (shown/accepted/dismissed/typed-past) and TTFT p50/p99, stored locally in `~/.floo-network/completion-telemetry.json` (D25)
- **Spec alignment**: Update code-editor spec to reflect FIM completion implementation (D26)

## Capabilities

### New Capabilities

- `fim-completion`: AI-powered fill-in-the-middle code completion using a local bundled model, with inline ghost text in the editor and Tab to accept

### Modified Capabilities

- `code-editor`: Update the "Completion-interface seam for future FIM model" requirement to reflect that FIM completion is now implemented (D26)

## Impact

**Affected code:**

- `src-tauri/src/lib.rs`: Add `complete_code` command and sidecar lifecycle management (D6, D19)
- `src-tauri/src/terminal.rs`: Pattern reference for sidecar process management (D4)
- `src-tauri/tauri.conf.json`: Add `bundle.resources` and `bundle.externalBin` configuration (D17, D18)
- `src/FileEditorPane.tsx`: Replace dropdown autocomplete with ghost text extension (D5)
- `src/api.ts`: Add `complete_code` wrapper (D6)
- Settings UI: Add completion enable/disable toggle (D22)

**New dependencies:**

- llama-server binary (bundled as sidecar, ~10MB) (D18, D24)
- Qwen3.5-0.8B.Q4_K_M.gguf model (bundled as resource, ~540MB) (D9, D21)

**Systems:**

- App bundle size increases by ~550MB (model + inference engine) (D17, D18, D24)
- Sidecar process adds ~26MB RSS memory overhead during runtime (D12)
- HTTP IPC on localhost for completion requests (D3, D36)
- Local telemetry file for acceptance metrics (D25)
