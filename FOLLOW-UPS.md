# Floo Network — follow-ups

Deferred work, deliberately not done in the day-23 build. Each entry says what
is missing, why it was left, and what closing it involves.

## 1. ~~Crash reaction has no test~~ — DONE

Closed. `executor::on_crash` was extracted from `AppSink::emit` and covered
red-first by `a_crash_reverts_the_thread_and_clears_its_session`; the sink now
calls it, so the test guards the production path. Task 5.7 is genuinely met and
re-checked. See E19.

## 2. Graphify target guard has no test (`-integrations`)

`run_graphify` canonicalizes the user's scope input and requires it to stay
inside the active project, so a scope like `../..` can't point Graphify outside
it. This is a trust boundary and it has no test, for the same reason as above —
it sits in a Tauri command.

**To close:** extract `resolve_target(project_root, subpath) -> Res<PathBuf>`
into `integrations.rs` and cover: a real subdirectory passes, empty means whole
project, `../..` is rejected, an absolute path outside the root is rejected.

## 3. Idle gating is only tested one layer down (`-executor-handoff`)

`executor::send` rejecting a mid-turn send is tested
(`a_second_turn_is_rejected_while_the_first_is_in_flight`). The `is_busy()`
guard in the `go_mode` / `spec_mode` commands — the one a user actually hits —
is not. Low value: it's a one-line `is_busy()` check over state the layer below
already tests, and covering it needs the same extraction treatment item 1 got —
`go_mode`/`spec_mode` would have to split their guard out of the Tauri command.

## 4. Codex adapter is unverified (E16) — and cheap to close

`parse_codex_line` and the per-turn `codex exec resume --last` spawn path are
implemented and exercised by the fake-executor stub, but have never been run
against a real `codex`. The event schema is written from Codex's documented
`item.started` / `item.completed` shape, not from observed output.

**Correction:** E16 originally claimed codex wasn't installed here. That was
wrong — **Codex CLI 0.146.0 is installed** at
`~/.nvm/versions/node/v24.16.0/bin/codex`. I asserted its absence without ever
running `command -v codex`. So this is not blocked; it just wasn't done.

**To close (now easy, on this machine):** run one cheap real turn, capture the
JSONL, and check `parse_codex_line` against it — the same probe that caught
Claude's missing `--verbose`:

```
codex exec "reply with the single word pong" --json --sandbox read-only -C <dir>
```

Check specifically: whether the item type key is `item_type` or `type`, whether
`turn.completed` is really the terminal event, and the exact field names on
`command_execution` (`aggregated_output`, `exit_code`) and `file_change`
(`old_content`, `new_content`). The parser tolerates either `item_type` or
`type` already, but the rest is unconfirmed guesswork.

## 5. Graphify shell-out is unverified (I6)

Same posture. `graphify` is not installed here and is not published under that
name on pip or npm — the npm package of that name is unrelated. The argument
construction follows D8's documented CLI shape; the disk-parsing and failure
paths are covered using stand-in processes, and the pane was driven end to end
against a stub that produced real data from this repo's import graph.

**To close:** install the real Graphify and confirm `graphify_args` matches its
actual flags, and that its `graph.json` node attributes carry a community key
`communityOf()` recognises (it tries `community`, `group`, `cluster`, `module`,
`type`, `kind`, `category` before falling back to `ungrouped`).

## 6. Work-laptop packaging is unrun (P9)

`-distribution` §4 and §5.1 are unchecked. The identity-generation procedure and
`package.sh` are machine-agnostic, but neither has been run on the work laptop.
Each machine generates its own signing identity (P2), so nothing carries over
except the written procedure.

## 7. App icon has a baked-in background

`assets/icon.png` is a 1024×1024 with the dark navy background rendered in, so
the macOS icon is a square tile rather than the usual rounded shape. Cutting the
background to alpha would make it sit correctly next to other Dock icons.

## 8. Frontend has no automated tests

There is no Vitest/RTL setup. UI behaviour was verified by driving the running
app through the Tauri MCP (per C9 — Playwright cannot drive a macOS WKWebView),
which is agent-driven and doesn't re-run on its own. Pure functions worth
covering if that changes: `itemsFromMessages` (structured-event round trip and
the plain-text fallback) and `buildModel` (community ranking, the eight-hue cap
folding into "Other", dangling-edge rejection).
