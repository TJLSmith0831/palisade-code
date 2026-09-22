# Launch prep — change log

Branch: `worktree-launch-prep` (worktree at `.claude/worktrees/launch-prep`). Started 2026-09-22.

Decisions confirmed with owner up front:
- Intel Macs: ship one **universal** dmg (aarch64 + x86_64 sidecar lipo'd).
- License: **Apache-2.0**.
- Cleanup: remove dev leftovers (bug-report.md, benchmark-*.sh, CONTEXT.md, .codex/hooks.json, docs/pr/**, docs/research/*). Keep DESIGN.md, PRODUCT.md, docs/adr, docs/*.md.
- One PR.
- Never rewrite git history. Secrets found in history are reported, not scrubbed.

## Status

- [x] 1. "Unreviewed" turn status
- [x] 2. Universal macOS build (Intel + Apple Silicon)
- [ ] 3. Playbooks UI pass (Railway feel) + Brooks review
- [ ] 4. Open-source prep + repo cleanup
- [ ] 5. Launch nice-to-haves (5 personas)
- [ ] 6. Brooks review of changes and whole app, fix bugs
- [ ] 7. PR

## Pre-flight audit

- Secret scan of all 377 commits (Anthropic/OpenAI/GitHub/AWS/Slack/HF keys, private keys, Apple API key/issuer, Tauri signing key, JWTs): **0 hits**. `.env` was never tracked; only `.env.example` is.
- Personal identifiers that remain on purpose: bundle id `com.tjlsmith0831.palisade-code` (changing it orphans every installed tester's updater + keychain entries), the `palisade-updates.tjlsmith0831.workers.dev` endpoints, HF model repo name. Test fixtures under `src-tauri/tests/fixtures/*.txt` contain old `/private/tmp/claude-501/-Users-tjlsmith0831-…` paths; harmless, left alone.

## Changes

### 1. Unreviewed status — commit `feat(fleet): promote finished-but-unopened turns…`

- `FleetStatus` gains `unreviewed` (Rust `fleet.rs`, TS `api.ts`). Precedence: permission → running → problem (verify failed / conflict / crash) → **unreviewed** (turn ended, thread not opened since) → idle.
- Removed the old `turn_done` attention reason and the `has_diff` gate: a finished turn is unreviewed whether or not it changed files.
- Fleet board: fourth band + fourth header count ("Unreviewed", `--warn` dot). Sidebar: fourth band, `data-state="unreviewed"` dot, tooltip "Finished — you haven't looked yet". Review list: "Unreviewed" badge (warn); "Needs attention" badge moved from warn → danger to match the board's dot.
- Bug fixed on the way: a turn ending on the thread already on screen (window focused) now records the view immediately, instead of flagging itself under the user's nose.
- Tests: 40 Rust fleet tests, FleetBoard/SessionList/ReviewRunList vitest files (90 tests) green; `tsc` clean.

### 2. Universal dmg — commit `build(release): ship one universal macOS dmg…`

- `tester-release.yml`: both Rust targets; sidecar built twice (arm64 Metal, x86_64 CPU-only AVX2 cross-compiled with `GGML_NATIVE=OFF`) and lipo'd; `--target universal-apple-darwin` on both `tauri build` calls; bundle paths moved to `target/universal-apple-darwin/…`; `lipo -info` asserts on the app binary, the sidecar, and the mounted dmg.
- Manifest smoke test now requires `darwin-universal`, `darwin-aarch64`, `darwin-x86_64`.
- `worker/`: `UPDATE_TARGET` → `UPDATE_TARGETS` (space-separated list); one archive offered under every key so pre-universal installs keep updating. **Needs `npx wrangler deploy` from `worker/` after merge** — the live Worker still has the old single-key var until then.
- `test.yml`, `.gitignore` (glob), `scripts/link-sidecar.sh` (all three triples), AGENTS.md, PRODUCT.md, docs/tester-releases.md, openspec D20a.
- Not run: the actual CI release (needs a tag + the `testers` environment approval). YAML validated, worker tests 7/7.
- Local `package.sh` is unchanged: host-arch only, for dev.
