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
- [x] 3. Playbooks UI pass (Railway feel) — Brooks review pending in step 6
- [x] 4. Open-source prep + repo cleanup
- [x] 5. Launch nice-to-haves (5 personas) — two shipped, three recommended
- [x] 6. Brooks review of changes and whole app, fix bugs
- [x] 7. PR (opened from branch `worktree-launch-prep`)

Left behind on purpose: a test playbook `draft-then-review` saved in `/private/tmp/palisade-launch-fixture/.palisade/chains/` while screenshotting. Delete it if the fixture should stay pristine.

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

### 3. Playbooks — commits `feat(playbooks): give the canvas a Railway-style pass`, `fix(playbooks): keep the empty card…`

Railway reference (from web research, not a live session — the extension was not connected): dark near-black canvas with a dot grid, service cards (icon tile + name, status dot + label, metadata line), smooth bezier connections that animate while deploying, a right-side inspector that leaves the canvas visible, a floating "apply changes" bar for staged edits, one accent used sparingly, Inter at 13px, 6–8px radii, no shadows at rest.

Applied within DESIGN.md (tokens, One Accent Rule, Resting-Plane Rule, Mantine-only widgets):
- Dot grid on the surface at the 20px snap pitch, following pan/zoom via inline `background-position/size`.
- Node card 220×84, radius 8, glyph tile + role + START, agent · model line, 2-line guideline, status dot + label; `data-selected` ring while the inspector is open; executing node's glyph turns accent.
- Forward edges are horizontal S-curves; edge out of an executing node is accent + animated dash (reduced-motion safe).
- Staged-changes bar docked bottom-center: "Unsaved changes · Discard · Save". The toolbar Save button is gone; Save exists only when there is something to save; Discard reverts to the on-disk playbook through the undo stack.
- Empty state is a card: "Start a playbook", one primary "Add your first node", 4-term legend (node/edge/gate/loop).
- Inspectors (node/edge Drawers) dim the graph 25% instead of blacking it out.
- Validation problems only show once the canvas is dirty.
- Panel: **Duplicate** (`<name> copy`, `copy 2`, …) and **Delete…** with a confirm modal.
- CSS: the stray chain block (was ~6403–6476) moved beside the main block; `.ds-chains-empty` styled.
- Verified live in the dev app (screenshots in `docs/screenshots/`). Tests updated: ChainCanvas 52, ChainsPanel 10, designTokens green; `tsc` clean.
- Not done, deliberately: drag-to-connect from a port (click-then-click stays), edge labels, multi-select. Not run: an actual playbook test run (would spend agent turns; if you want it, set both nodes to Sonnet first).

### 4. Open source — commit `chore(oss): prepare the repository for public beta`

- New: `LICENSE` (Apache-2.0), `NOTICE` (llama.cpp MIT + model note), `CONTRIBUTING.md` (setup, merge gate, rules, glossary), `CODE_OF_CONDUCT.md` (Covenant 2.1), `SECURITY.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml + config.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, `docs/screenshots/{playbooks,fleet}.png`.
- Rewritten: `README.md` (badges, hero, what it does, install table incl. Intel, build, docs, contributing, license).
- Metadata: `license`/`repository`/`description` in package.json; `license`/`repository`/`authors` in Cargo.toml (was `authors = ["you"]`).
- Removed: `bug-report.md`, `benchmark-fim.sh`, `benchmark-static-server.sh`, `CONTEXT.md`, `.codex/hooks.json`, `docs/pr/**` (37 screenshots), `docs/research/ade-market-survey-2026-09.md`. PRODUCT.md pointer updated. openspec archive files still mention the benchmark scripts as historical sources; left as records.
- **Owner to confirm:** copyright holder string "TJLSmith0831 and the Palisade Code contributors" in LICENSE/NOTICE/Cargo.toml — swap for a legal name or entity if you have one. Also: enable "Private vulnerability reporting" in the GitHub repo settings (SECURITY.md and the issue chooser link to it).
- Practices borrowed: Emdash (Apache-2.0, install table per platform, privacy section, Conventional Commits, no CLA), Zed (problem-statement-first feature process, "a human must understand every line", glossary, small-PR rule).

### 5. Launch nice-to-haves — commit `feat(fleet): dock badge and a Next unreviewed thread command`

Personas (what each one needs from a first session to come back for a second):

| # | Persona | First-session need | Shipped here | Recommended next |
|---|---|---|---|---|
| 1 | **Solo founder / indie hacker** running 3–5 agent threads at once while doing other work | Know the instant a turn finishes without watching the window | **Dock badge** (attention + unreviewed count) | macOS notification on turn-done while unfocused (needs `tauri-plugin-notification`, ~1h) |
| 2 | **Senior engineer** who distrusts AI diffs and reviews everything | Clear an inbox of finished turns fast; evidence before merge | **⌘⇧U Next unreviewed thread** with remaining count | "Review next" variant that lands in the Review lane instead of the thread |
| 3 | **Tech lead** standardising how the team uses agents | Shareable, repeatable flows | Playbook **Duplicate** + confirm-delete; playbooks live in `.palisade/chains/*.json` so they ship with the repo | A `palisade-playbooks` starter repo with 3 worked playbooks (review-then-fix, spec-then-build, test-then-doc) |
| 4 | **OSS maintainer** evaluating a new tool | Trust: license, security policy, how to contribute, one install path | LICENSE / SECURITY / CONTRIBUTING / templates; universal dmg | **Homebrew cask** (`brew install --cask palisade`): needs a `homebrew-palisade` tap repo and a release step that writes the dmg sha256 into it — ~1h, highest-leverage install win for developers |
| 5 | **Newcomer to agentic coding** deciding in 10 minutes | A guided first run | Welcome screen already detects agents; README says what to install | First-run checklist when no agent is installed (install link, login, "send your first prompt"), replacing the bare chat-only warning |

Deliberately not built: notifications and Homebrew both need an external dependency or a second repo; you should approve those. Windows/Linux stays out of scope for launch.

### 6. Brooks review — pass 1 (branch diff) — commits `fix(fleet): measure Unreviewed against the agent's last message…`, `docs: say when a session record actually closes`

Found and fixed in the branch's own changes:
- **Critical, fixed:** Unreviewed compared `last_viewed_at` with the session's `ended_at`. Idle ACP sessions only close at app quit (`release_idle_sessions_on_exit`), so `ended_at` was None all day (band never fired) and then newer than every view on the next launch (every thread fired). Now compares against the newest non-user message (`store::last_agent_activity`), with a store test. The pre-existing "Turn finished" reason had the same latent defect.
- **Warning, fixed:** dock badge written from a window with no project (welcome screen / mid-switch) would clear another window's badge — guarded.
- **Warning, fixed:** update Worker with an unset `UPDATE_TARGETS` would publish `platforms: { "undefined": … }` — now throws; test added.
- **Suggestion, fixed:** `lipo -info | tee | grep -q` in the release workflow relied on tee never seeing EPIPE; rewritten as a variable check.
- **Suggestion, fixed:** CLAUDE.md and a `selectThread` comment still said a thread switch releases idle sessions; it does not.
- Noted, not changed: `set_dock_badge` is last-writer-wins across windows and `fleet_overview` only covers the projects *this* window shows, so two windows on different projects show the count of whichever refreshed last. Acceptable for beta; the fix is a badge derived in Rust from all open projects.

Gates after fixes: `pnpm test` 83 files / 1382 tests, `cargo test` 818 passed / 1 ignored, `tsc` clean, worker tests 7/7.

### 6. Brooks review — pass 2 (whole app, launch lens) — commits `fix: close the launch bug-hunt findings`, `refactor(playbooks): one stateLabel…`, `docs(openspec): check off chain-run-history wiring…`

A read-only bug hunt over the hot paths (fleet derivation, first run offline, updater, store durability, event relay, preview/terminal, Intel). Confirmed and fixed:
- **High, fixed:** `acp_registry` fallback list fabricated agents as bare `npx` (no package, no args). Offline first run with node installed → "Claude Agent installed" → first message spawns `npx` alone → crash. Removed the list (CLAUDE.md: never hardcode an agent; PRODUCT.md: degrade honestly). Preflight now distinguishes "registry unreachable, no cache" from "none on PATH".
- **High, fixed:** a registry listing that fetched with zero manifests (raw.githubusercontent blocked) was cached as fresh `[]` for 24h → chat-only for a day. Empty is now an error; partial is served but not cached. Pure `accept_fetch` policy + 2 tests replace 3 tests that hit the network / asserted the fabricated list.
- **Medium, fixed:** PreviewPane: a probe *error* (unresolvable `*.localhost`) cleared the error state without showing the view → blank pane, no retry. Now shows the view.
- **Medium, fixed:** `pidguard` test depended on whether `sh -c "sleep 30 # token"` exec'd sleep (token vanishes from `ps`); compound command keeps sh resident.
- **Low, fixed:** `store::write_json` fsyncs before rename (APFS power-cut → zero-length meta → thread silently missing from the sidebar). Session-log writer / seq-cache lock poison now recovers instead of failing every later append. `release_idle_sessions_on_exit` uses `lock_or_recover`.
- **Playbooks (R3 Knowledge Duplication), fixed:** `ChainRunCard` carried a copy of `ChainCanvas`'s `stateLabel`; now imported.
- **Spec drift, fixed:** `chain-run-history/tasks.md` §2.1–2.5 + 3.2 were unchecked though shipped (verified: `mod chain_history`, both commands registered, api wrappers, chain_exec records, re-run-from-node). `chain-execution-gaps/tasks.md` §2–3 claim a human node that has no symbols on main — annotated, not flipped.
- **Noted, not fixed:** `fswatch::tests::does_not_report_our_own_write` is timing-flaky under a parallel full run (failed once, passed 3/3 alone; FSEvents arming). Pre-existing; unrelated to this branch.

Verified clean by the pass: brand-new thread derives Idle; app opens offline; updater failures are swallowed and never block startup; `preview_probe` is loopback-only; terminal backlog offset has no off-by-one; no aarch64 hard-coding in runtime paths (Intel-safe).
