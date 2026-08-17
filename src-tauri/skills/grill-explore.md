---
name: grill-explore
description: OpenSpec explore mode that persists — think through an idea or problem as a sparring partner, but write every settled decision to disk the moment it lands, so a later grill-propose (or a fresh session) inherits the thinking instead of losing it to compaction. Use when the user says "grill-explore", "let's explore this" in an OpenSpec project, or wants to think through a change before proposing it. Part of the grill suite (grill-explore → grill-propose → grill-apply → grill-archive); replaces the explore step and feeds grill-propose.
---

# Grill-Explore

Stock `openspec-explore` is a good thinking partner with a fatal default:
it only _offers_ to capture insights, and only into an existing change's
artifacts. Exploration usually happens _before_ a change exists, so the
conclusions live in chat — and die with compaction or the session. The next
`/opsx:propose` then starts cold and guesses.

This skill keeps explore's posture — think, investigate, sketch options,
never implement — and changes exactly one behavior: **capture is automatic,
immediate, and works before a change exists.**

## Preflight

Check `command -v openspec` succeeds and the project resolves an OpenSpec
root (`openspec context` works, or an `openspec/` directory exists). If
not, stop and tell the user: `npm i -g @fission-ai/openspec`, then
`openspec init`. Never fall through to a raw CLI error.

## The notes file

On entry, derive a short kebab-case topic from what's being explored and
open `openspec/explore/<topic>.md` (create `openspec/explore/` if needed).
If a notes file for this topic already exists, read it first and continue
it — that's a prior session's thinking, not clutter.

Append a decision entry the moment something settles — a choice made, an
assumption invalidated, a scope boundary drawn, a requirement discovered.
Same format grill-propose consumes:

```markdown
## D<n>: <the question, one line>

- **Decision**: <what was settled>
- **Why**: <one sentence>
- **Source**: user | codebase (<path:line>) | recommended-accepted
```

Don't ask permission to capture — say "logged" in passing and keep
thinking. The user can strike an entry; they can't recover one that was
never written. Ideas still in play stay in chat; only _settled_ things
enter the file. If a settled thing later unsettles, amend the entry rather
than appending a contradiction.

## How to explore

- **Think out loud, ground in the codebase.** Read files, trace flows,
  check whether the thing the user believes about the code is true. An
  exploration that never opens a file is speculation.
- **Go one thread at a time.** When stress-testing an idea, use grilling
  discipline: one question, with your recommended answer, wait for the
  response. Don't scattershot five concerns at once.
- **Surface tradeoffs as options with a recommendation**, not as a survey.
  "A is simpler, B handles the offline case; I'd take A unless offline
  matters — does it?"
- **Check existing specs and changes early** (`openspec list`,
  `openspec list --specs`) — exploring something a spec already covers, or
  an in-flight change already touches, is the first thing worth knowing.
- **Never implement.** No application code. Writing the notes file is
  capturing thinking, not implementing.

## Exit

When the exploration feels change-shaped — scope, approach, and non-goals
have entries — say so and emit the marker `[READY_TO_PROPOSE]` on its own
line at the end of your final message. Palisade strips the marker from the
visible text and auto-fires `grill-propose`; the user does not need to click
a button. If the user isn't ready, that's fine; omit the marker and the
notes file waits for the next session either way.
