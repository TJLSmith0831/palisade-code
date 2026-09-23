---
name: grill-propose
description: Build an OpenSpec change proposal through a relentless one-question-at-a-time interview instead of batch generation. Use when the user says "grill-propose", "grill this into a spec/proposal", "propose this but interview me first", or complains that /opsx:propose or openspec-propose produced a shallow or generic spec. Part of the grill suite (grill-explore → grill-propose → grill-apply → grill-archive); replaces the propose step. Consumes grill-explore's notes; grill-apply consumes the decision log this skill produces.
---

# Grill-Propose

Stock `openspec-propose` batch-generates proposal.md, design.md, and
tasks.md in one pass, with an explicit instruction to "prefer making
reasonable decisions to keep momentum." That momentum is where lackluster
specs come from: every gap the user never spoke to gets filled with a
plausible guess, and the guesses read fine until implementation.

This skill inverts it: **no sentence enters an artifact unless it traces to
a resolved decision.** Decisions get resolved by interviewing the user one
question at a time (grilling), by reading the codebase, or by harvesting
context that already exists — and every resolution is written to disk
immediately, so nothing depends on the chat surviving.

## Preflight

If `command -v openspec` fails, run every `openspec` command in this skill
as `npx -y @fission-ai/openspec@1.13.1` instead — the version Palisade pins.
The project needs an OpenSpec root: `openspec/` exists, or create it with
`openspec init --tools none .`. Only if neither `openspec` nor `npx` is
available, stop and tell the user to install Node.js. Never fall through to
a raw CLI error.

## The decision log

The single persistence layer, shared with `grill-explore`:

- Before a change exists: `openspec/explore/<topic>.md` (grill-explore writes these)
- Once the change exists: `<changeRoot>/decisions.md`

Format — one entry per resolved question, appended the moment it resolves,
never at the end of a phase:

```markdown
## D<n>: <the question, one line>
- **Decision**: <what was decided>
- **Why**: <one sentence>
- **Source**: user | codebase (<path:line>) | grill-explore | recommended-accepted
```

`recommended-accepted` means you proposed an answer and the user said yes —
still a real decision, distinct from a silent guess.

If the session dies mid-grill, `decisions.md` is the checkpoint. On
invocation, always check for an existing log first and resume from it
rather than re-asking answered questions.

## Phase 0 — Harvest (before asking anything)

Never ask a question whose answer already exists. Before the first
question, gather:

1. **This conversation** — anything the user already said about the change.
2. **Explore notes** — `openspec/explore/*.md` for a matching topic; if
   found, seed the decision log from it and tell the user which decisions
   you're carrying forward.
3. **Existing specs and changes** — `openspec list`, `openspec list --specs`,
   and any change artifacts that overlap this one. Conflicts with an
   existing spec are a grilling question, not something to silently
   resolve.
4. **The codebase** — the files this change will touch. Read them.

Anything harvested that materially shapes the change goes into the log as a
decision with its source. If a harvested answer seems stale or ambiguous,
confirm it in one question rather than trusting or re-litigating it.

## Phase 1 — Grill

Interview the user about the change until every artifact can be written
without inventing anything. Rules, inherited from grilling and enforced:

- **One question at a time.** Wait for the answer before the next
  question. Multiple questions at once is bewildering and produces
  half-answers.
- **Recommend an answer with every question.** "Should deletes cascade? I
  recommend yes, because X." The user correcting a concrete recommendation
  yields sharper decisions than an open-ended prompt.
- **If the codebase can answer it, don't ask.** Explore, resolve, log it
  with `Source: codebase`, and mention it in passing.
- **Walk the tree in artifact order**, resolving dependencies between
  decisions as you go:
  1. *Proposal-level*: why now, who benefits, scope, explicit non-goals,
     what "done" looks like.
  2. *Design-level*: approach and its rejected alternative(s), data shapes,
     failure and edge cases, integration points, migration if any.
  3. *Task-level*: sequencing, what's riskiest (do it first), what can be
     verified per task.
- **Append to the log after every resolution.** Not batched. This is the
  entire point of the skill.

Stop when a pass over each artifact's sections finds no section you'd have
to guess at. Tell the user you're done grilling and how many decisions are
in the log. If the user says "enough, just write it" mid-grill, honor it —
but log the unresolved questions as open items at the bottom of
decisions.md so the artifacts can flag them instead of papering over them.

Create the change directory (`openspec new change "<name>"`) as soon as the
change has a settled name — usually a few questions in — and move the log
into it, so everything after that point lives where OpenSpec expects it.

## Phase 2 — Artifacts, one at a time

Follow the stock OpenSpec loop, but gated:

1. `openspec status --change "<name>" --json` for the artifact build order
   (`applyRequires`, dependency order, `resolvedOutputPath`s).
2. For each ready artifact: `openspec instructions <artifact-id> --change
   "<name>" --json`, honor its `template`, `context`, and `rules` exactly
   as stock propose does (constraints for you, never copied into output).
3. **Draft the artifact from decisions.md.** Every substantive claim traces
   to a D-entry, the codebase, or the user's words. If drafting surfaces a
   gap the grill missed, stop and grill that one question — don't guess.
   Unresolved open items appear in the artifact as explicit `> Open:`
   markers, never as confident filler.
4. **Show the draft and get a verdict before writing the next artifact.**
   Edits become new or amended D-entries first, then land in the file — the
   log stays the source of truth. If the user says "looks good, finish the
   rest without me," fast-forward the remaining artifacts without
   per-artifact sign-off.
5. Repeat until every `applyRequires` artifact is done, then show
   `openspec status --change "<name>"` and point at `/grill-apply`, which
   implements with decisions.md as binding context.

## What this skill does not do

- No implementing — that's apply's job.
- No re-grilling settled decisions when the user asks for a small artifact
  edit — amend the entry and move on.
- No skipping Phase 0 because the user seems in a hurry. Harvest is what
  prevents the "misses my previous context" failure; it's the one step
  that is never optional.
