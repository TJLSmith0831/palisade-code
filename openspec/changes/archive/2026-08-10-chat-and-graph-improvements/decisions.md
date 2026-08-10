# Floo Network improvements — decision log

Three items from a 2026-08-04 investigation session (no code changed during
that investigation): Graphify always-on, real text streaming for chat, and
thread deletion. Harvested facts below are carried forward from that
session's codebase reading; grilling starts after the harvest.

## D1: What is `graphify` and how is it actually installed?
- **Decision**: Real package is PyPI `graphifyy` (double-y), installed via
  `uv tool install "graphifyy[watch]"`. Its console-script entry point is
  literally named `graphify`, matching `find_on_path("graphify")` in
  `src-tauri/src/lib.rs:353`. The `[watch]` extra is required for the
  `graphify watch` subcommand (pulls in `watchdog`).
- **Why**: Verified by downloading the real wheel and inspecting
  `entry_points.txt` and `METADATA`'s `Provides-Extra` list; confirmed
  live via `uvx --from graphifyy graphify --help`.
- **Source**: codebase (`src-tauri/src/integrations.rs`, `lib.rs:353-355`)
  + external verification (PyPI wheel inspection, `graphify --help`)

## D2: Does floo-network's PATH detection need fixing for graphify?
- **Decision**: No. `find_on_path()` already has a login-shell PATH
  fallback (tested at `executor.rs:770`+), the same mechanism used for
  `claude`/`codex`. The current error is correct — `graphify` truly isn't
  installed on this machine.
- **Why**: Confirmed no `graphify` binary anywhere on PATH or via pip/npm
  under the plain name before finding the real `graphifyy` package.
- **Source**: codebase (`executor.rs` PATH fallback + its own test)

## D3: Are `graphify_args()`'s assumed CLI flags correct?
- **Decision**: No, two real bugs, found by diffing `graphify_args()`
  (`integrations.rs:41`) against the real `extract --help`:
  1. The "incremental" toggle appends `--update` to `graphify extract`,
     but `extract` has no `--update` flag — incremental rescanning is the
     separate `graphify update <path>` subcommand. Currently a silent
     no-op.
  2. `--no-viz` is always appended but isn't a real `extract` flag either
     (it belongs to `cluster-only`/`tree`). Harmless no-op (unrecognized
     flags are silently ignored by graphify's parser), but should be
     removed since it does nothing.
  Also found, same root cause: the `path` query subcommand needs two
  positional node names (`graphify path "A" "B"`), but `GraphPane`'s query
  UI only collects one text field — selecting "path" today would
  misbehave.
- **Why**: `integrations.rs` carries a `ponytail:` comment admitting the
  shape was "written against D8's documented CLI shape but never run
  against a real `graphify`." It wasn't correct.
- **Source**: codebase (`integrations.rs:41-59`, `GraphPane.tsx` query UI)
  + external verification (real `graphify extract --help`, `graphify
  --help` full command list)

## D4: What building block does "always on" need?
- **Decision**: `graphify watch <path>` — a real, purpose-built persistent
  process (needs `watchdog`, hence the `[watch]` extra) that debounces
  file changes (3s default, configurable) and does incremental,
  no-LLM-needed AST rebuilds automatically on code changes.
- **Why**: Read `graphify`'s own `watch.py` from the real wheel — it's a
  mature, already-solved problem (polling observer on macOS specifically
  because FSEvents misses rapid saves, debounce, lock file for concurrent
  rebuilds, etc.), not something floo-network should reimplement.
- **Source**: codebase (external: `graphify`'s `watch.py`, function
  `watch()` at line 1582)

## D5: Does floo-network have any existing precedent for a supervised
long-lived background process?
- **Decision**: Yes — `executor::Session` already supervises the
  long-lived `claude`/`codex` child process (spawn, track busy/idle,
  detect crash, terminate). A `graphify watch` supervisor should follow
  the same shape, not invent a new one.
- **Why**: Nothing else in the codebase manages a persistent child
  process; `integrations.rs`/`run_graphify` today only ever does one-shot
  `Command::new(bin).output()` calls.
- **Source**: codebase (`executor.rs` `Session` struct and its
  spawn/terminate/`is_busy()` methods)

## D6: Does the Claude adapter already support real token streaming?
- **Decision**: The CLI flag is already there — `claude_args()`
  (`executor.rs:453`) passes `--include-partial-messages`, confirmed via
  the installed `claude --help` to enable `stream_event`/
  `content_block_delta` lines when combined with `--print
  --output-format stream-json` (both already passed). But
  `parse_claude_line()` (`executor.rs:203`) has no match arm for `type ==
  "stream_event"` — those lines fall into the catch-all `_ => {}` and are
  silently dropped. The frontend only ever sees one complete `Text`/
  `Reasoning` event per finished block, which is why text appears to
  "pop in" instead of streaming.
- **Why**: This is the root cause the user is calling "the weird collapse
  thing" for the *streaming* half of item 2 — not a missing capability,
  a dropped event type.
- **Source**: codebase (`executor.rs:203-266`, `:445-464`) + external
  verification (`claude --help`)

## D7: Can Codex stream the same way?
- **Decision**: No known way today. Codex's adapter (`parse_codex_line`)
  only handles `item.completed` (whole blocks); FOLLOW-UPS.md #4 already
  notes the event schema is docs-only/unverified because this machine's
  Codex isn't authenticated. No delta-level Codex event is documented.
- **Why**: Real streaming (item 2) would necessarily be Claude-only unless
  Codex's real CLI turns out to expose something finer-grained — that's
  a genuine asymmetry the proposal needs to state, not paper over.
- **Source**: codebase (`executor.rs` Codex match arms, `FOLLOW-UPS.md`
  item 4)

## D8: Are the "collapse" widgets for thinking/tools a bug?
- **Decision**: No — `Reasoning` and `ToolBlock` in `EventView.tsx` are
  deliberately built as per-message `<details>`-style disclosures, closed
  by default. This is a UX preference to change, not a defect to fix.
- **Why**: Confirmed by reading the component: `useState(false)` for
  `open`, toggled only by clicking the head button — working as coded.
- **Source**: codebase (`EventView.tsx` `Reasoning`/`ToolBlock`
  components)

## D9: Does thread deletion exist anywhere today?
- **Decision**: No. Not in `store.rs` (`create_thread`/`rename_thread`/
  `list_threads` exist, no `delete_thread`), not as a Tauri command in
  `lib.rs`, not in `api.ts`, not in `App.tsx`'s UI.
- **Why**: Direct grep across all four layers found nothing.
- **Source**: codebase (`store.rs`, `lib.rs`, `api.ts`, `App.tsx`)

## D10: What would deleting a thread actually touch on disk?
- **Decision**: A thread is exactly two flat files —
  `threads_dir/<ulid>.meta.json` and `threads_dir/<ulid>.jsonl` — and
  `list_threads()` just globs `*.meta.json` in that directory. No
  separate index/manifest to keep in sync; delete is "remove both files."
- **Why**: Read `create_thread`/`list_threads`/path helpers directly.
- **Source**: codebase (`store.rs:165-213`)

## D11: What existing guard pattern should a delete command reuse?
- **Decision**: `executor::Session::is_busy()` already gates `go_mode`/
  `spec_mode` against a second turn while one is in flight
  (`executor.rs:535`, FOLLOW-UPS.md #3). A delete command on the
  currently-active thread should reuse the same guard rather than invent
  a new one.
- **Why**: Only one executor turn runs app-wide at a time; deleting the
  thread backing an in-flight turn mid-write would corrupt or orphan
  state.
- **Source**: codebase (`executor.rs:397-437`, `:535`)

## D12: Does floo-network have any native confirm()/prompt() available for
a delete confirmation?
- **Decision**: No. `App.tsx` already documents that `window.prompt` is a
  no-op in Tauri's WKWebView (returns null without showing a dialog) and
  built a custom command-bar overlay (`bar` state) as the only way to
  collect a line of text from the user. The same no-op almost certainly
  applies to `window.confirm`.
- **Why**: Direct comment in `App.tsx:28-30` plus the existence of the
  custom overlay as the app's only text-input mechanism — no other
  dialog primitive is used anywhere in the codebase.
- **Source**: codebase (`App.tsx:27-34`)

## D14: Why now, and who benefits?
- **Decision**: These are the user's own daily-use pain points hit while
  using floo-network themselves — a broken Graphify PATH error, a chat UI
  that doesn't stream, and no way to clean up finished threads. The user
  is the sole beneficiary; this is a personal dev tool, not a
  multi-user product.
- **Why**: Directly stated when the user framed the three items as
  "improvements I wanna make / bugs to resolve" against their own daily
  driver.
- **Source**: user (original request framing this session)

## D13: One combined change or three separate changes?
- **Decision**: One combined OpenSpec change covering all three items.
- **Why**: User's explicit call, overriding the recommendation (three
  separate changes matching subsystem boundaries and monorepo precedent).
- **Source**: user

## D15: Fix the D3 CLI-shape bugs in this same change?
- **Decision**: Yes, in scope. `graphify_args()`'s `--update`/`--no-viz`
  handling and the `path` query's two-node UI get fixed alongside the
  always-on work.
- **Why**: "Always on" is meaningless if the incremental rebuild it
  triggers is silently a no-op — D4 depends on D3 being correct.
  Recommended and accepted.
- **Source**: recommended-accepted

## D16: Does `graphify watch` start automatically, or via a per-project toggle?
- **Decision**: Automatic, no toggle. Starts whenever a project is
  opened/switched to. A missing `graphify` binary (or failed spawn) shows
  as a warning banner, matching the existing executor preflight-warning
  pattern — not a silent feature-gate.
- **Why**: User explicitly asked for "always on"; a toggle would
  reintroduce the manual step being eliminated. Recommended and accepted.
- **Source**: recommended-accepted

## D17: Does an auto-rebuild inject a chat message, or just refresh the pane?
- **Decision**: Silent pane refresh only. Watcher updates `graph.json` and
  the pane picks it up automatically; no chat injection. Manual "Run
  Graphify" keeps injecting, since that's a deliberate share-with-executor
  action.
- **Why**: Watch can fire every few seconds while editing; injecting into
  whatever thread is open on every rebuild would spam it. Recommended and
  accepted.
- **Source**: recommended-accepted

## D18: Is Claude-only real streaming acceptable, with Codex staying block-level?
- **Decision**: Yes. Claude turns get real incremental streaming; Codex
  turns still render as soon as each block completes (no artificial
  delay), just not token-by-token.
- **Why**: No verified delta-level Codex event schema exists (D7); this is
  a CLI/adapter limitation floo-network can't fix unilaterally.
  Recommended and accepted.
- **Source**: recommended-accepted

## D19: What does "toggles for thinking" mean?
- **Decision**: A global show/hide preference (topbar toggle, e.g. "show
  thinking: ON/OFF"), not a per-message click-to-expand. When on,
  reasoning text streams inline (dimmed, alongside the answer) like the
  message text does. When off, reasoning is not rendered at all — no
  per-message disclosure widget remains.
- **Why**: Matches how Claude.ai/ChatGPT expose extended thinking; removes
  the per-message interaction entirely rather than just changing its
  default state. User picked this over "keep the per-message block, just
  default it open."
- **Source**: user

## D20: Does tool-call rendering change from today's click-to-expand?
- **Decision**: No. Tool-call blocks stay collapsed-by-default with
  click-to-expand, same as today. Only the header's live status
  (name + running…/done) must genuinely update in real time as the call
  progresses — which the existing `!output && "running…"` label mostly
  already does.
- **Why**: Tool output (command stdout, file diffs) can be long/noisy;
  collapsed-by-default with a live status line matches how real
  coding-agent UIs handle this. Only reasoning gets the global-toggle
  treatment (D19). Recommended and accepted.
- **Source**: recommended-accepted

## D21: Confirm-then-delete, immediate delete, or soft-delete with undo?
- **Decision**: Confirm, then hard delete. A custom confirmation
  (matching the existing rename command-bar overlay pattern, since
  native `confirm()` no-ops in Tauri's WKWebView per D12) precedes
  permanently removing both files. No undo/trash state.
- **Why**: Native dialogs don't work here regardless (D12), so some custom
  UI is required either way; a confirm step is the minimum safety net
  without building a soft-delete/archive system for a personal tool.
  Recommended and accepted.
- **Source**: recommended-accepted

## D22: Post-delete fallback when the open thread is the one deleted?
- **Decision**: Fall back to the next remaining thread in the list, or the
  empty "create a thread to get started" state if none remain — reusing
  `selectProject`'s existing `found[0] ?? null` fallback logic.
- **Why**: Proven pattern already in the codebase for the equivalent
  project-switch case; no need to invent new UX. Recommended and accepted.
- **Source**: recommended-accepted

---

## D23: Does the "show thinking" toggle persist across app restarts?
- **Decision**: Yes. Saved like other app state (e.g. `localStorage`,
  matching the existing `lastThreadKey`-per-project pattern already in
  `App.tsx`) so it doesn't reset every launch.
- **Why**: Surfaced while drafting the chat-streaming spec — D19 settled
  what the toggle does but not whether it persists. Recommended and
  accepted.
- **Source**: recommended-accepted

## D24: How does incremental interact with subpath scoping, given `graphify update` has no `--out` override?
- **Decision**: Disable (grey out) the incremental checkbox in `GraphPane`
  whenever the scope field has a subpath. Whole-project incremental runs
  (`graphify update <root>`, output at `<root>/graphify-out`) work
  normally; subpath + incremental is not offered rather than silently
  writing to the wrong directory or silently ignoring the subpath.
- **Why**: Discovered during implementation of task 2.2 — `update <path>`
  has no `--out` flag (unlike `extract`), so its output always lands at
  `<path>/graphify-out`. `run_graphify` always reads back from
  `default_out_dir(root)`; a subpath-scoped `update` would write
  somewhere the pane never reads, going silently stale. No clean way to
  target a subdirectory's changes while writing to the root's
  `graphify-out` exists in the real CLI. User picked disabling the
  combination over silently ignoring the subpath.
- **Source**: user (amends design.md's "invoke `graphify update <target>`"
  language, which didn't account for the missing `--out` flag)

## D25: `extract` never writes GRAPH_REPORT.md — fix by chaining `cluster-only`
- **Decision**: `run_graphify`'s non-incremental branch becomes a two-step
  chain: `graphify extract <target> --out <project-root> --code-only
  [--mode deep]`, then (on success) `graphify cluster-only <project-root>
  --no-viz`. `--out` now passes the project root itself, not
  `<root>/graphify-out` — the CLI appends `graphify-out/` under whatever
  `--out` receives, so the old code was writing one level too deep
  (`<root>/graphify-out/graphify-out/`). If `cluster-only` fails after a
  successful `extract`, that failure is surfaced as the run's error (same
  "failed run injects nothing into the thread" contract, just triggered by
  either step now).
- **Why**: Verified live against the real `graphify` (`graphifyy` 0.9.32)
  binary — confirmed directly in graphify's own source comment
  (`cli.py:3685-3686`): "extract intentionally stops at graph.json +
  analysis; the report and community labels are produced by
  `cluster-only`." Every manual "Run Graphify" would have failed at
  `read_run()` otherwise, independent of every other fix in this change.
  `update`/`watch` are unaffected — both route through the shared
  `_rebuild_code` implementation, which already writes `GRAPH_REPORT.md`
  directly, and neither has a `--out` flag to misuse in the first place.
  Confirmed `cluster-only` degrades gracefully with no API key configured
  (auto-keeps `Community N` placeholders) — no `--no-label` flag needed.
- **Source**: user (amends the graphify-integration spec's "Run Graphify
  against the active project" requirement, which assumed a single
  `extract` call was sufficient)

## D26: What UI shows a `graphify-warning` event?
- **Decision**: Reuse the existing dismissible error banner (`App.tsx`'s
  `error`/`setError` state) rather than building a new warning UI. The
  persistent preflight-warnings banner stays reserved for the static
  "graphify not on PATH" case (D-covered by extending `preflight()`);
  `graphify-warning` (spawn failure for another reason, or a later crash)
  routes through the one-off dismissible banner instead.
- **Why**: Trivial — the spec only requires "shows a warning," not a
  specific mechanism, and the existing banner is the app's only precedent
  for a one-off informational message. No new UI needed.
- **Source**: recommended-accepted

## D27: Real `stream_event` envelope shape, verified live
- **Decision**: Confirmed via two live `claude --print --input-format
  stream-json --output-format stream-json --include-partial-messages
  --verbose` turns that the envelope is exactly what D6 assumed:
  `{"type":"stream_event","event":{"type":"content_block_delta","delta":
  {"type":"text_delta","text":"..."}}}` (and `"thinking_delta"` with a
  `.thinking` field, `"signature_delta"` with a `.signature` field that is
  not renderable text). Implemented `parse_claude_line`'s new match arm
  and its tests against this exact shape.
- **Caveat, not a bug**: in both captures — a trivial echo prompt and a
  "think step by step" arithmetic prompt — `thinking_delta.thinking` came
  through as an empty string; the only signal was an `estimated_tokens`
  counter. The model's readable thinking text may rarely or never
  actually stream in this configuration (Claude Sonnet 5, headless CLI,
  no extra thinking-budget flag — `claude --help` has no such flag). The
  existing empty-content guard (`if !text.trim().is_empty()`, and the new
  delta path's `!text.is_empty()`) already handles this correctly by not
  emitting an empty `Reasoning`/`ReasoningDelta`. This means the "show
  thinking" toggle (D19) may often have nothing visible to show in
  practice — a real-world characteristic of the CLI's current headless
  output, not a defect in this change's parsing.
- **Why**: Matches this change's own discipline (D25 already showed
  `--help` text alone isn't trustworthy) — verified against a live,
  authenticated `claude`, not assumed from docs.
- **Source**: codebase (external: live-captured JSON, `claude --help`)

## Open items

None remaining — every proposal- and design-level question has a resolved
decision above. Task-level sequencing will be resolved while drafting
tasks.md.
