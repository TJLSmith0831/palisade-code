---
name: grill-archive
description: Archive a completed OpenSpec change, migrating the durable "why" from the decision log into the living main specs before the change dir moves to the archive folder — stock sync only carries requirements, so rationale otherwise rots in archive/. Use when the user says "grill-archive", or wants to archive a change that was built with the grill suite (grill-explore → grill-propose → grill-apply → grill-archive). Replaces the archive step, same mechanics underneath.
---

# Grill-Archive

Stock archive syncs delta specs into the main specs, then moves the change
directory to `changes/archive/YYYY-MM-DD-<name>/`. Nothing is destroyed —
`decisions.md` moves along with it — but spec sync only carries
*requirements*. The rationale never reaches the living spec; six months
later someone reads "deletes cascade" with no idea it was chosen over
soft-delete and why. This skill is stock archive plus one step: **migrate
the durable decisions into the main specs before the move.**

## Preflight

Check `command -v openspec` succeeds and the project resolves an OpenSpec
root (`openspec context` works, or an `openspec/` directory exists). If
not, stop and tell the user: `npm i -g @fission-ai/openspec`, then
`openspec init`. Never fall through to a raw CLI error.

## The flow

1. **Select the change.** If no name given, `openspec list --json` and let
   the user pick — never guess at archive time.
2. **Completion checks**, as stock: `openspec status --change "<name>"
   --json` for artifact status; count `- [ ]` vs `- [x]` in the tasks
   file. Warn on anything incomplete and confirm before proceeding — an
   unresolved `> Open:` marker in any artifact counts as incomplete too.
3. **Decision migration** — the grill addition, before sync so one review
   covers both:
   - Read `<changeRoot>/decisions.md`. If it doesn't exist, skip this step
     silently and proceed as stock archive.
   - Triage the entries. **Durable**: a future reader of the main spec
     would want it — rejected alternatives, constraints that shaped the
     design, "we deliberately don't do X" boundaries. **Ephemeral**: only
     mattered while building — sequencing, naming, anything the code now
     states plainly. Most entries are ephemeral; a typical change yields a
     handful of durable ones.
   - For each durable entry, append a one-to-two-line distillation under a
     `## Decisions` section in the relevant main spec
     (`openspec/specs/<capability>/spec.md`), with the archive date:
     `- Cascade deletes over soft-delete — audit table covers recovery;
     soft-delete flags poisoned every query. (2026-07-16, add-user-auth)`
   - Show the user which entries you're migrating and where before
     writing. Their call is final; migrating too much buries the spec.
4. **Delta spec sync**, as stock: compare delta specs against main specs,
   summarize what would change, prompt to sync (recommended) or archive
   without.
5. **Perform the archive**, as stock: `mkdir -p` the archive dir, fail if
   `YYYY-MM-DD-<name>` already exists, then `mv "<changeRoot>"
   "<changesDir>/archive/YYYY-MM-DD-<name>"`. The full decisions.md rides
   along as the historical record — migration copies the durable why, it
   doesn't strip the log.
6. **Summary**: change name, archive location, sync result, and how many
   decisions were migrated into which specs.
