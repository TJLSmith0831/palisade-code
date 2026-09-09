# Native macOS Application Menu — TDD Implementation Plan

## Outcome

Palisade exposes a native macOS application menu that feels familiar to users
arriving from JetBrains IDEs, Zed, and VS Code-family products. The menu is the
system menu bar shown while Palisade is foreground; it is not duplicated inside
the custom 36px title bar.

The top-level menus are:

`Palisade · File · Edit · View · Go · Run · Window · Help`

All menu items are honest: an item either dispatches a working Palisade command
to the focused window or is visibly disabled. Checked and dynamic items reflect
the focused window's current state. Existing toolbar, palette, and keyboard
entry points continue to work.

## Approved Scope

The user approved the complete menu proposal, including changing Toggle
Terminal from `Cmd+Backtick` to `Ctrl+Backtick`. Work may run `pnpm install`,
frontend tests/build, Rust tests, `pnpm start`, and Tauri UI automation. Do not
package, install into `/Applications`, sign, publish, or perform destructive Git
operations.

## Product and Platform Constraints

- Palisade's current beta target is macOS on Apple Silicon.
- `src-tauri/tauri.conf.json` uses `decorations: false` and a transparent title
  bar. The native application menu is independent of those window decorations.
- Multiple project windows may be open. Every command must affect the focused
  window, never the first or most recently created window by accident.
- A window without an active project must keep the menu discoverable while
  disabling project-dependent commands.
- Existing dirty-buffer confirmation behavior must survive menu-driven tab,
  window, and application closing.
- Use title-style capitalization. Add an ellipsis only when more information is
  required before the action completes.

## Public Interface and Deep-Module Seam

The menu is another adapter over Palisade's command system, not a parallel
command implementation.

The external seam is a small command interface:

```ts
type CommandId = string;

type CommandState = {
  enabled: boolean;
  checked?: boolean;
  label?: string;
};

dispatchCommand(id: CommandId): void;
menuState(): Record<CommandId, CommandState>;
```

The interface includes these invariants:

1. Toolbar controls, keyboard shortcuts, command palette rows, and native menu
   items dispatch the same stable command IDs.
2. Native events are routed only to the focused Palisade window.
3. Command state is derived from the focused window and synchronized after any
   relevant project, tab, layout, theme, terminal, debugger, updater, or agent
   state change.
4. Native/application roles own standard macOS behavior where Tauri and
   WKWebView support it; editor-specific behavior crosses the same command seam.
5. Unknown command IDs are ignored safely and may be logged in development.

The native adapter may be Rust-owned or use Tauri's JavaScript menu API, but it
must preserve the focused-window invariant and keep menu definitions/state
local. Do not scatter menu-specific event listeners throughout UI components.

## Menu Contract

### Palisade

- About Palisade
- Check for Updates…; dynamically becomes Restart to Update when ready
- separator
- Settings… — `Cmd+,`
- separator
- Services submenu
- separator
- Hide Palisade — `Cmd+H`
- Hide Others — `Option+Cmd+H`
- Show All
- separator
- Quit Palisade — `Cmd+Q`

### File

- New File… — `Cmd+N`
- New Thread…
- separator
- Open Project… — `Cmd+O`
- Open Recent submenu: up to 10 recent projects, then Clear Menu
- Clone Repository…
- Open Current Project in New Window
- separator
- Open Project Settings
- separator
- Save — `Cmd+S`
- separator
- Close Tab — `Cmd+W`
- Reopen Closed Tab — `Shift+Cmd+T`
- Close Window — `Shift+Cmd+W`

### Edit

- Undo — `Cmd+Z`
- Redo — `Shift+Cmd+Z`
- separator
- Cut — `Cmd+X`
- Copy — `Cmd+C`
- Paste — `Cmd+V`
- Select All — `Cmd+A`
- separator
- Find… — `Cmd+F`
- Find Next — `Cmd+G`
- Find Previous — `Shift+Cmd+G`
- Find in Project… — `Shift+Cmd+F`

Edit commands operate on whichever compatible surface has focus, including the
CodeMirror editor, composer, palette/search inputs, settings inputs, and
terminal. Prefer Tauri predefined roles for standard responder-chain behavior;
add a focused-editor adapter only where native roles do not work in WKWebView.

### View

- Command Palette… — `Shift+Cmd+P`
- separator
- Workspace Layout submenu: Editor and Vibe radio/check items
- Appearance submenu: System, Light, and Dark radio/check items
- separator
- Show/Hide Side Panel — `Cmd+Backslash`
- Show/Hide Chat Panel — `Cmd+J` in Editor layout
- Show/Hide Editor Panel — `Cmd+J` in Vibe layout
- Show/Hide Terminal — `Ctrl+Backtick`
- Show/Hide Changes
- Toggle Markdown Preview — `Shift+Cmd+V`, enabled for Markdown only
- separator
- Enter Full Screen — `Ctrl+Cmd+F`

### Go

- Go to File… — `Cmd+P`
- Go to Line… — `Ctrl+G`
- Go to Definition — `F12`
- separator
- Next Tab — `Ctrl+Tab`
- Previous Tab — `Ctrl+Shift+Tab`

### Run

- Run Last Configuration
- Run Configuration submenu populated from project run commands
- Configure Run Commands…
- separator
- Start Debugging — `F5`
- Stop Debugging — `Shift+F5`
- separator
- Stop Active Agent Session

Run commands, debugger actions, and Stop Active Agent Session are enabled only
when their existing Palisade state allows them. Do not bypass existing guards.

### Window

- Minimize — `Cmd+M`
- Zoom
- separator
- Next Window — `Cmd+Backtick`
- Previous Window — `Shift+Cmd+Backtick`
- separator
- One checked item per open project window, with the focused window checked
- separator
- Bring All to Front

### Help

- Commands and Shortcuts… — `Shift+Cmd+P`
- separator
- Report a Bug / Request a Feature…

Do not add placeholder Documentation, Selection, Terminal, Agent, Code,
Refactor, Build, Tools, or VCS top-level menus in this change.

## TDD Strategy

Use vertical tracer bullets only: one failing behavioral test, the smallest
implementation that makes it pass, then the next failing test. Do not write all
tests before implementation. Tests exercise public behavior and stable command
IDs, not internal helper call counts.

### Slice 1 — Native skeleton and dispatch tracer bullet

**RED:** From the menu's public construction/dispatch interface, assert that
the macOS menu contains the eight approved top-level menus and selecting one
custom item emits its stable command ID to the focused window only.

**GREEN:** Install the smallest native menu and focused-window dispatcher that
passes the test.

### Slice 2 — Existing command reuse

Add one test and implementation at a time for:

- Command Palette, Go to File, Find in Project, Close/Reopen Tab, Next/Previous
  Tab, layout toggle, side-panel toggle, secondary-pane toggle, changes toggle,
  terminal toggle, Settings, and Project Settings.
- Existing shortcuts and UI entry points continue to dispatch the same IDs.
- Change Toggle Terminal to `Ctrl+Backtick`; prove `Cmd+Backtick` is available
  for window cycling.

### Slice 3 — File and project lifecycle

Add one test and implementation at a time for New File, New Thread, Open
Project, Open Recent, Clone Repository, Open Current Project in New Window,
Save, Close Window, and state-sensitive disabling. Reuse existing confirmation
flows for dirty work.

### Slice 4 — Edit responder behavior

For each representative focus context, write a failing behavior test then make
it pass:

- CodeMirror: Undo/Redo, Cut/Copy/Paste, Select All, Find/Next/Previous.
- Ordinary text input or composer: Cut/Copy/Paste/Select All.
- Terminal: standard terminal editing/clipboard behavior remains intact and
  global shortcuts do not steal ordinary terminal input unexpectedly.

### Slice 5 — Checked and dynamic View state

Add tests one behavior at a time for layout and appearance checkmarks, dynamic
Show/Hide labels, Markdown-only enablement, fullscreen, and onboarding/no-
project disabled state.

### Slice 6 — Go commands

Add tests and minimal implementation for Go to Line and Go to Definition using
the active editor's public interface. Preserve existing file and tab commands.

### Slice 7 — Run, debug, and active-agent state

Add tests one behavior at a time for dynamic run configurations, Run Last,
Configure, debug start/stop enablement, and stopping only the active thread's
active session.

### Slice 8 — Window and app lifecycle

Add tests one behavior at a time for Minimize, Zoom, Full Screen, next/previous
window, checked window list, Bring All to Front, About, Settings, updater state,
Hide, and Quit. Prove commands target the focused window in a two-window test.

### Slice 9 — Help and beta affordances

Connect Commands and Shortcuts and the existing tester feedback modal. Reuse
the updater and feedback state rather than duplicating their implementations.

### Refactor only while GREEN

After every slice is green, remove duplication and deepen the command/menu
module. Run the focused tests after each refactor. The deletion test should
hold: removing the command module would force command routing, shortcut,
enabled-state, and native-menu complexity back into many callers.

## Verification Ladder

Run the narrowest relevant test after every red/green cycle, then finish with:

1. `pnpm test -- --run` (or the repository's equivalent non-watch invocation)
2. `pnpm build`
3. `cd src-tauri && cargo test`
4. Launch with `pnpm start`
5. Drive the real Tauri app through the debug MCP bridge on `127.0.0.1:9223`
6. Verify the native macOS menu visually and behaviorally, including onboarding,
   an active project, dirty file handling, terminal shortcut, and two windows
7. Capture a screenshot as proof; capture a short recording only if the
   available tooling makes it straightforward

## Acceptance Criteria

- The macOS global menu bar shows exactly the eight approved top-level menus.
- Palisade's in-window title bar does not contain a duplicate menu row.
- Every visible item works or is visibly disabled.
- Displayed shortcuts, global handlers, and command-palette descriptions agree.
- `Cmd+Backtick` cycles Palisade windows and `Ctrl+Backtick` toggles Terminal.
- Menu actions apply only to the focused window with multiple project windows.
- Checked layout/theme/window items and dynamic labels remain accurate.
- Project/editor commands are disabled on onboarding and enable after opening a
  compatible project/file.
- Dirty-file confirmation protects Close Tab, Close Window, and Quit paths.
- Existing toolbar and palette entry points do not regress.
- Frontend tests, frontend build, and Rust tests all pass.
- A cleanly launched real app passes the Tauri MCP smoke test.

## Research Basis

- Apple menu guidance: <https://developer.apple.com/design/human-interface-guidelines/menus>
- Apple file-management guidance: <https://developer.apple.com/design/human-interface-guidelines/file-management>
- Tauri 2 native menu documentation: <https://v2.tauri.app/learn/window-menu/>
- VS Code default macOS shortcuts: <https://code.visualstudio.com/docs/reference/default-keybindings>
- Zed keybindings and command model: <https://zed.dev/docs/key-bindings>
- JetBrains macOS keymap: <https://www.jetbrains.com/help/idea/reference-keymap-mac-default.html>

## Explicit Non-Goals

- No custom in-window menu bar.
- No Windows/Linux menu fallback in this beta change.
- No keymap editor or user-remappable shortcuts.
- No new public documentation site.
- No packaging, signing, notarization, installation, or release publishing.
- No unrelated editor, agent, Git, or terminal feature work.
