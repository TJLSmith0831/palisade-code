# Palisade Code — follow-ups

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

## 4. Codex adapter — partially verified now (E16, E20)

Running the real Codex CLI 0.146.0 found three defects the fake-executor stub
could never have caught, because the stub only emitted the happy path I had
imagined: `codex exec` refuses to run outside a git repo, it reads stdin, and a
failing turn emits `turn.failed` (not `turn.completed`) so the harness hung
forever with no explanation. All three are fixed and covered by a regression
test built from real captured output. See E20.

**Still unverified:** the success-path item schemas. This machine's Codex is
**not authenticated** — the probe reached `thread.started` / `turn.started` and
then failed with `401 Unauthorized`. So these field names are still guesses from
docs:

- `agent_message` → `text`
- `command_execution` → `command`, `aggregated_output`, `exit_code`
- `file_change` → `path`, `old_content`, `new_content`

**To close:** authenticate Codex (`codex login`), run one cheap turn that both
executes a command and edits a file, and check those against real output:

```
codex exec "run: echo hi, then create a.txt containing hi" \
  --json --sandbox workspace-write --skip-git-repo-check -C <dir>
```

## 5. ~~Graphify shell-out is unverified~~ — DONE

Closed by `chat-and-graph-improvements` (decisions D25, D27). `graphify` is
real (PyPI `graphifyy`, `uv tool install "graphifyy[watch]"`) and was
installed and run against this repo's own source. The documented CLI shape
(I6) was wrong in two ways `--help` text alone didn't reveal: `extract`
never writes `GRAPH_REPORT.md` (a separate `cluster-only` call is
required), and `--out <dir>` writes to `<dir>/graphify-out/`, not `<dir>`
— the original code passed the wrong path for both. Fixed and driven end
to end against the real binary, producing real data from this repo's own
import graph (617 nodes), including the always-on `graphify watch` path
(D4/D16), not just a manual run. `graph.json`'s node attributes did carry
a `communityOf()`-recognised key — no gap there after all.

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
the plain-text fallback), `buildModel` (community ranking, the eight-hue cap
folding into "Other", dangling-edge rejection), and `mergeDeltas` (delta
accumulation onto the right in-progress item, the complete-event replacing
the accumulation, a tool call correctly ending a delta run so a later delta
of the same kind starts fresh — `chat-and-graph-improvements`).

## 9. Two chat-and-graph-improvements pieces weren't live-verified

The `path`-query two-field UI (D3) and the incremental-checkbox-disabled-
when-a-subpath-is-set behavior (D24) are covered by `tsc` and code
inspection only — everything else in that change was driven against the
real running app, but these two weren't specifically clicked through.
Low risk (straightforward conditional rendering), but worth a quick manual
pass before relying on them.

Separately, not a bug but worth knowing: live-verified against the real
`claude` CLI (D27), Claude's `thinking_delta` content came through empty
in both prompts tried — only an `estimated_tokens` counter, no readable
text. The "show thinking" toggle (D19) is wired correctly, but may often
have nothing to display in practice; this appears to be how the CLI
streams reasoning today, not a palisade-code defect.
