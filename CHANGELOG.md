# Changelog

All notable changes to Palisade Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.0] - 2026-09-25

### Added

- Permission prompts now surface for tool calls an agent makes without announcing them first.
- Spec-mode stages are marked directly in the chat, and the stepper advances as soon as Propose is sent.
- Spec artifacts and Markdown render as documents instead of framed source, including a visual Markdown editor.
- Skills can be invoked from any chat, with @-mentions for threads and files and image attachments in messages.

### Changed

- Spec mode writes to the project root and auto-links and opens the resulting proposal.
- Spec and Fleet composer mentions, skills, and textarea sizing were reworked for consistency.

### Fixed

- Local-model thread titles are no longer discarded when they were usable.
- Text selection in the feedback modal no longer gets hijacked by the titlebar drag handler.
- Plain Spec turns now carry the grill skill; runs started from Fleet open their chat.

[Unreleased]: https://github.com/TJLSmith0831/palisade-code/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/TJLSmith0831/palisade-code/compare/v0.3.0...v0.4.0

## [0.3.0] - 2026-09-22

### Added

- Fleet board, Review lane, Playbooks, and Connections: Palisade pivoted from a single-thread chat shell into an Agentic Development Environment (ADE) that tracks every thread across open projects at once.
- Playbooks: saved graphs of agent nodes with gates (a verify command or a human approval), run as one unit from any thread.
- Native macOS application menu.
- Source Control view gained a working commit-graph, commit diffs, and an uncommitted-changes node.
- Durable executor authentication, so an agent's sign-in state survives across sessions.
- Local FIM completion switched to a stock Qwen2.5-Coder-0.5B model, with abstention and acceptance instrumentation.
- Launch prep: an Unreviewed status on the Fleet board, a universal (Apple Silicon + Intel) `.dmg`, and Apache-2.0 licensing with contributor, security, and conduct docs.
- Notebooks: run `.ipynb` cells against a live Jupyter kernel.
- Database connections store credentials as fields in the macOS keychain, and queries keep a history.
- Merge-back and prune-on-archive for thread worktrees, and a diff pane you can edit in.
- File tree: per-type icons and hover row actions.

### Changed

- Editor, Vibe, and Spec mode went through a maturity and polish pass.
- An audit pass hardened the design system, interface P1s, accessibility, path/process/lock safety, typed errors, and code decomposition across the app.
- Agent-chain (Playbook) run states and controls were polished based on an Impeccable critique.

### Fixed

- Diff pane rendering, a permission-prompt freeze, and streamed tool output.
- OpenSpec errors now reach the UI, the mode toggle no longer goes inert, crashes are split into retryable and fatal, and the ACP auth handshake completes.
- The collapsed editor column reopens when a tab opens.

[0.3.0]: https://github.com/TJLSmith0831/palisade-code/compare/v0.2.1...v0.3.0

## [0.2.1] - 2026-08-30

### Changed

- Slimmed release build (`chore(release): v0.2.1`), no user-facing behavior change.

[0.2.1]: https://github.com/TJLSmith0831/palisade-code/compare/v0.2.0...v0.2.1

## [0.2.0] - 2026-08-30

Earliest tagged release.

[0.2.0]: https://github.com/TJLSmith0831/palisade-code/releases/tag/v0.2.0
