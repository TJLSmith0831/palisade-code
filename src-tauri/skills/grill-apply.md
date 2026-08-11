---
name: grill-apply
description: Implement an OpenSpec change with the decision log as binding context — the "why" travels into implementation, and mid-build discoveries flow back into the log instead of silently diverging from it. Use when the user says "grill-apply", or wants to implement a change that was proposed with grill-propose. Part of the grill suite (grill-explore → grill-propose → grill-apply → grill-archive); replaces the apply step, same CLI underneath.
---

# Grill-Apply

Stock apply reads proposal, specs, design, and tasks — but not
`decisions.md`, so every "why" captured during grilling is invisible at
implementation time, which is exactly when tradeoffs get quietly re-decided
by accident. This skill is stock apply plus one rule: **the decision log is
binding context, and it stays current through implementation.**

## Preflight

Check `command -v openspec` succeeds and the project resolves an OpenSpec
root (`openspec context` works, or an `openspec/` directory exists). If
not, stop and tell the user: `npm i -g @fission-ai/openspec`, then
`openspec init`. Never fall through to a raw CLI error.

## The flow

Follow the stock apply loop — it's fine:

1. Select the change (given name → conversation inference → auto-select if
   only one active → otherwise `openspec list --json` and ask). Announce
   "Using change: <name>".
2. `openspec status --change "<name>" --json` for schema and paths.
3. `openspec instructions apply --change "<name>" --json` for
   `contextFiles`, progress, and task list. Handle `blocked` and
   `all_done` states as the CLI instructs.
4. Read every `contextFiles` path — **plus `<changeRoot>/decisions.md`.**
   If the log exists, its entries are constraints with the same weight as
   design.md: a D-entry saying "no caching in v1, Source: user" means you
   don't add caching because task 4 would be easier with it.
5. Implement tasks one at a time, minimal and focused, marking `- [ ]` →
   `- [x]` as you go.

If there's no decisions.md (change wasn't grilled), say so once and proceed
as stock apply — don't manufacture a log retroactively.

## The grill rules during implementation

- **Hitting an `> Open:` marker in an artifact** — that's an unresolved
  question grill-propose deliberately left visible. Resolve it before
  implementing the task it touches: one grilling question, recommended
  answer first, unless the codebase answers it. Log the resolution, remove
  the marker.
- **Implementation contradicts a decision** — you discover the decided
  approach doesn't work, or a cheaper one exists. Stop. One question to the
  user with what you found and what you recommend. The outcome is an
  *amended* D-entry (not a silent workaround, not a new contradicting
  entry), then the affected artifact, then the code — log first, always.
- **Implementation forces a decision nobody made** — a real choice with
  consequences (data shape, failure behavior, API surface) that no artifact
  or D-entry covers. If it's genuinely consequential, ask (one question,
  with recommendation); if it's trivial, decide and log it with
  `Source: recommended-accepted` so archive-time review can catch it.
  The test: would the user be surprised to learn this was decided for them?
- **Ordinary coding choices** — variable names, file organization, which
  loop construct — are not decisions. Don't bloat the log.

Pause on the same conditions as stock apply: unclear task, design issue,
blocker, or user interrupt.

## On completion

Show progress (N/M tasks), what was completed this session, and — the
grill addition — any D-entries added or amended during implementation, so
the user sees how the plan moved while it met reality. If all tasks are
done, point at `/grill-archive`.
