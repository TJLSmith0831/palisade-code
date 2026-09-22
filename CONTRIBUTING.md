# Contributing to Palisade Code

Thanks for looking. Palisade is a small codebase with strong opinions, and
the fastest way to land a change is to know them before you start.

## Before you write code

- **Bugs:** open an issue with the bug template, or go straight to a PR if
  the fix is small and comes with a test.
- **Features:** open an issue first and describe the problem, not the
  solution. Palisade says no to a lot of reasonable features on purpose
  (see [PRODUCT.md](PRODUCT.md)); a five-minute discussion beats a
  rejected week of work.
- **Design changes:** read [DESIGN.md](DESIGN.md). Every colour, radius and
  type size is a token; the test suite fails on off-scale values.

## Setup

macOS with `pnpm` and a stable Rust toolchain on `PATH`.

```bash
pnpm install          # frontend deps; also links the local sidecar into a worktree
pnpm start            # tauri dev: compiles the Rust backend and opens the window
```

The local-completion sidecar (`llama-server`) and its model are build
inputs, not source, and are gitignored. Without them the app runs with
completion disabled; nothing else depends on them. Tests never execute the
sidecar, but `tauri-build` insists the declared file exists, so an empty
`src-tauri/llama-server-aarch64-apple-darwin` is enough to compile.

## The merge gate

Run these before opening a PR and say in the PR which ones you ran:

```bash
npx tsc --noEmit
pnpm test
cd src-tauri && cargo test
```

CI runs the same three on every PR. For a UI change, include before and
after screenshots at the same window size.

## Working in the codebase

- **New IPC command = three edits:** the `#[tauri::command]` fn, its name
  in `generate_handler!` at the bottom of `src-tauri/src/lib.rs`, and a
  wrapper in `src/api.ts`. Miss the third and the frontend silently cannot
  call it.
- **Never hardcode an agent.** Agents come from the ACP registry at
  runtime and are spoken to over ACP. Adding one is a registry entry and a
  CLI on `PATH`, not a code change.
- **Verification is the only evidence.** No UI string may say complete,
  satisfied or implemented unless a named `verify` command exited 0 at a
  named commit. Task checkboxes are agent self-reports and are labelled as
  such.
- **Session history is append-only.** Never mutate a past message;
  truncate by copying forward.
- **Mantine components and Tabler icons only.** No hand-rolled widgets
  unless the design system has no primitive for it (the playbook canvas is
  the one exception, and every colour on it is still a token).
- **Shortest working diff.** One concern per PR, no drive-by refactors, no
  speculative abstractions. A `ponytail:` comment marks a deliberate
  simplification and names the ceiling it has.
- Frontend tests live in `src/__tests__/`, one file per source file. Rust
  tests are inline `mod tests`.

## Commits and PRs

- Conventional Commits: `feat(fleet): …`, `fix(acp): …`, `build(release): …`.
- Keep a PR to one concern. Split otherwise.
- A human must understand every line, including anything an agent wrote.
  We use agents heavily ourselves; we still review as if we didn't.

## Glossary

The words the code and the UI use. Using them the same way keeps issues,
PRs and the interface saying one thing.

| Term | Meaning | Not |
|---|---|---|
| **Project** | A repository Palisade has been pointed at. Owns threads, terminals, Preview and `.palisade/` settings. | workspace, folder |
| **Thread** | A conversation scoped to a project. Owns messages, mode intent and the spec link; may hold several sessions, live or closed. | chat, conversation |
| **Session** | One live or closed run of an agent process on a thread. Owns `busy`, the agent identity and the provider's resume handle. | run, turn |
| **Turn** | One prompt and the agent's reply to it, inside a session. Ends on `Done`; a session outlives it. | session |
| **Agent** | A coding CLI discovered from the ACP registry and driven over ACP (Claude Code, Codex, …). | executor, model |
| **Model** | What an agent is asked to run with. Chosen per thread; the agent decides what it offers. | agent |
| **Mode** | `spec` or `go`. Same agent, different permission flag and skill focus. There is no third mode. | plan / build, phase |
| **Worktree** | The isolated git worktree a thread's agent works in. One per thread, cut from the project's branch. | branch, sandbox |
| **Fleet** | Every thread across open projects, as rows with a status: attention, running, unreviewed, idle. The home screen. | dashboard |
| **Unreviewed** | A turn ended and nobody has opened the thread since. Nothing is blocked. | done, complete |
| **Review** | Reading a thread's diff file by file, with its verify evidence, before merge. | code review (of a PR) |
| **Verify** | A named command whose exit 0 at a named commit is the only evidence that work is done. | tests passed (as told by an agent) |
| **Spec** | An OpenSpec change. OpenSpec is authoritative; Palisade only reads and shells out to it. | plan, ticket |
| **Playbook** | A saved graph of agent nodes joined by edges with optional gates, run as one unit. Identifiers in code still say `chain`. | chain (in UI), workflow, pipeline |
| **Gate** | A pause on a playbook edge: a verify command or a human approval. | checkpoint |
| **Preview** | The native browser view for a dev server the project started. One per project. | iframe, browser tab |

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the project. There is no CLA.
