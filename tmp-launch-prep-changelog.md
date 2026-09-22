# Launch prep — change log

Branch: `worktree-launch-prep` (worktree at `.claude/worktrees/launch-prep`). Started 2026-09-22.

Decisions confirmed with owner up front:
- Intel Macs: ship one **universal** dmg (aarch64 + x86_64 sidecar lipo'd).
- License: **Apache-2.0**.
- Cleanup: remove dev leftovers (bug-report.md, benchmark-*.sh, CONTEXT.md, .codex/hooks.json, docs/pr/**, docs/research/*). Keep DESIGN.md, PRODUCT.md, docs/adr, docs/*.md.
- One PR.
- Never rewrite git history. Secrets found in history are reported, not scrubbed.

## Status

- [ ] 1. "Unreviewed" turn status
- [ ] 2. Universal macOS build (Intel + Apple Silicon)
- [ ] 3. Playbooks UI pass (Railway feel) + Brooks review
- [ ] 4. Open-source prep + repo cleanup
- [ ] 5. Launch nice-to-haves (5 personas)
- [ ] 6. Brooks review of changes and whole app, fix bugs
- [ ] 7. PR

## Changes

(appended as work lands)
