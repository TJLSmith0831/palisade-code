## 1. Tab data model

- [x] 1.1 Add `PreviewTab = { type: "preview"; url: string | null; dirty: false; mdPreview: false }` to the `OpenTab` union in `src/openTabs.ts` (D12).
- [x] 1.2 Add the `"preview"` case to `tabKey`, returning the constant `"preview"` (singleton tab, D-shape decision in design.md).
- [x] 1.3 Add an `openPreviewTab(url?: string)` helper (in `openTabs.ts` or alongside it) that opens the singleton Preview tab if absent, or focuses/renavigates the existing one if present — the single entry point used by both the "+" menu (manual) and the auto-detect listeners (D9/D11).

## 2. Tab bar "+" menu (New File / New Preview)

- [x] 2.1 Wire "New File" to the app's existing `setBar({ kind: "input" })` name prompt in `App.tsx`, which writes the file at the project root via `api.writeFileContent`, invalidates the file-tree cache, and opens it in a tab (D14, amended — `FileTree` only mounts with the Explorer panel open, so its inline create input can't be driven from the tab bar). Keep the explorer's existing per-folder "New File" behavior unchanged.
- [x] 2.2 Add a "+" icon button to `TabBar.tsx`, inline after the last tab (Chrome-style).
- [x] 2.3 Wire the button to a small dropdown (Mantine `Menu`) with "New File", "New Preview", and "New Chain" items (D16).
- [x] 2.4 "New File" calls the lifted create-file callback from 2.1 (project root); "New Preview" calls `openPreview()` from 1.3; "New Chain" calls the existing `openChain(null)`.

## 3. Preview pane rendering

- [x] 3.1 Create `PreviewPane.tsx`: URL bar (editable, submits on Enter/blur to navigate), reload button, always-visible "open in external browser" button.
- [x] 3.2 Render the current URL in an `<iframe>` (D1); empty state (no URL yet) shows just the URL bar, no iframe.
- [x] 3.3 Wire "open in external browser" to `@tauri-apps/plugin-opener`'s `openUrl()` (D6) with the current URL.
- [x] 3.4 Add the load-failure timeout: on navigation, start a short timer; if the iframe's `onLoad` hasn't fired by expiry, show a passive "Not loading? Open externally." hint (D8). Mark the timeout duration with a `ponytail:` comment per design.md.
- [x] 3.5 Wire the `"preview"` case into `ds-main`'s tab-content switch in `App.tsx`, alongside the existing file/spec/table/query/chain cases.

## 4. Dev-server URL auto-detection

- [x] 4.1 Write the shared `detectDevServerUrl(text: string): string | null` utility matching `https?://(localhost|127\.0\.0\.1)(:\d+)?[^\s"'<>]*`, returning the last match.
- [x] 4.2 Add a `terminal-output` listener (alongside `TerminalPane.tsx`'s existing one) that base64-decodes each chunk, appends to a rolling buffer (a few KB, trimmed), and runs `detectDevServerUrl` against the buffer.
- [x] 4.3 Add an `executor-event` listener filtering for `ExecutorEvent::ToolResult`, running `detectDevServerUrl` directly against `output` (D9).
- [x] 4.4 Track the last auto-navigated URL; only call `openPreviewTab(url)` when a detected URL differs from it, so repeated identical output (e.g. HMR reconnect banners) doesn't re-trigger (D11, dedup).
- [x] 4.5 Confirm `openPreviewTab` switches the active tab immediately when called from auto-detection (D11) — same helper as the manual path, so this should fall out of 1.3 with no extra branching.

## 5. Verification

- [x] 5.1 Manual pass through `specs/preview-pane/spec.md`'s scenarios: open via "+" dropdown, manual URL navigation, reload, external-open (including with no URL loaded and with a failed load), load-failure hint timing, auto-open from a real `pnpm dev`/`vite` terminal run, auto-open from an agent Bash tool call running the same, repeated-URL no-op, availability in both Vibe and Editor mode.
- [x] 5.2 `npx tsc --noEmit` and `pnpm test` clean.
- [x] 5.3 Confirm "done" bar (D15): Preview tab opens manually (via "+" → "New Preview") AND via agent-driven auto-detection, both verified in Vibe mode and in Editor mode — four combinations, all working.
