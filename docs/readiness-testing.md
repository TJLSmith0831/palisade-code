# Repeatable native release checks

Use a clean candidate, existing sign-in with permission, and disposable projects.
Run builds/tests sequentially. Keep universal support: Rosetta tests the Intel
slice on Apple Silicon, not physical Intel performance or older macOS versions.

## Prepare once per candidate

Record `git rev-parse HEAD`, `sw_vers`, and `uname -m`. Check main CI/security.
Run the normal baseline once (do not enable readiness-test for the normal suite):

```sh
pnpm exec vitest run --maxWorkers=2
pnpm build
CARGO_BUILD_JOBS=2 TOKIO_WORKER_THREADS=2 RAYON_NUM_THREADS=2 \
  cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

Build the pinned universal sidecar with `PALISADE_BUILD_JOBS=2 bash scripts/build-sidecar.sh`
(requires CMake), or reuse the official release's sidecar only after confirming
its pinned revision matches this candidate. Keep its provenance in the report.
Both architecture-specific sidecars and the universal sidecar must be present.

```sh
env -u APPLE_SIGNING_IDENTITY -u APPLE_API_KEY -u APPLE_API_ISSUER \
  -u APPLE_API_KEY_PATH -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  CARGO_BUILD_JOBS=2 pnpm tauri build --target universal-apple-darwin \
  --features readiness-test --config src-tauri/tauri.readiness.conf.json --bundles app
```

No release signing credentials, install, notarization, or publishing are needed.
The opt-in feature requires an explicit PALISADE_TEST_DIR; normal builds ignore
these test controls. It redirects the session store and release model cache,
and restricts executable discovery to the profile's bin directory. The launcher
links installed git/node/python3/openspec there so project tooling stays
available while coding agents are hidden. The separate
bundle identifier isolates Tauri-managed app data. Provider authentication,
global CLI packages, and the OS keychain are not a fresh-user simulation.
Webview preferences may persist between profile paths because the test bundle
identifier stays fixed; the store, executable discovery and model cache reset.

## Run the matrix

Create a new set of known fixtures (the script refuses an existing directory):

```sh
python3 scripts/readiness-fixtures.py /tmp/palisade-readiness-fixtures-run1
```

Open its `project` directory in Palisade. Its `drops` directory contains text,
an image, and intentionally unreadable text. Permission denied is expected for
the unreadable file; readable files in the same drop should still import.
For the useful Go task, ask Luna to add `farewell(name)` returning
`f"Goodbye, {name}!"`, add one assert, and run `python3 greet.py`. Review the diff,
commit through Source Control, and merge through Review with the same configured
verification command. Never ask it to modify this repository.

Choose a new, nonexistent absolute profile path for each first-use run. The
launcher marks profiles it creates and refuses an unmarked existing directory.
Example (replace the profile suffix for each run):

```sh
bash scripts/readiness-profile.sh \
  'src-tauri/target/universal-apple-darwin/release/bundle/macos/Palisade Readiness.app' \
  /tmp/palisade-readiness-arm-run1 none arm64
```

Quit normally, then rerun with the same profile and `codex` instead of `none`.
The installed Codex/npx executables become discoverable without uninstalling
anything. Explicitly select advertised `gpt-6-luna` before every test turn.
Do not use another advertised Luna variant or fabricate a model ID.
The launcher uses Codex ACP's INITIAL_AGENT_MODE=read-only ("Ask for approval")
preset to make an actual permission denial possible instead of auto-reviewing
the request. In Go, ask Luna to request permission for one `curl -I https://example.com`
network command, deny it, forbid retries, then send a harmless follow-up turn.
If the installed adapter no longer supports this preset, record NOT RUN; do
not inject a fake provider request and call it a native pass.

Repeat with a separate fresh profile and `x86_64` instead of `arm64`. Confirm
Rosetta is available using `/usr/bin/arch -x86_64 /usr/bin/uname -m`.
Use `lipo -archs` on both bundled executables; inspect actual app/supervisor/
sidecar process architecture (for example macOS `sample`) before claiming an
Intel run. A universal parent's architecture does not prove its children's.

| Check | Evidence to retain |
|---|---|
| Empty profile, no discoverable agent | Native missing-agent recovery UI; useful disabled-action explanation |
| Empty model cache | Real model download/setup, health response, usable completion |
| Agent recovery | Codex visible after restart, explicit Luna selection, first and second replies |
| Useful work | Disposable Go edit, runnable check, reviewed diff, app merge, final clean Git state |
| Continuity | Unique harmless marker; normal quit/restart; correct recall; no duplicated history |
| Permission denial | Actual provider request, understandable native prompt, Deny, responsive next turn. Auto-approval is not a pass |
| Physical drops | Drag external text/image from Finder to Explorer, composer, read-only previews; inspect narrow light/dark controls |
| Import safety | Sources retained, collision skipped, partial failure reported; retain traversal/symlink regressions |
| Clean exit | App and newly started sidecar processes gone |

Physical drops need a human when native automation cannot map cross-window
coordinates. Synthetic DOM/IPC events are not physical-drop evidence. Mark each
row PASS, FAIL, or NOT RUN, and distinguish automated regressions from native checks.
The Retina routing regression is `pnpm exec vitest run src/__tests__/App.test.tsx
-t 'routes Retina' --maxWorkers=2`. Repeat physical drops after Tauri/Wry updates:
WKWebView supplies logical coordinates despite the API's physical-position type.
Stop after the core bar; no broad polishing. A skipped required check is not a pass.

## Cleanup and verdict

Quit the app normally first. Save a short report, logs, screenshots and relevant
fixture diffs under /tmp. Remove only marked disposable profiles and projects;
remove their own Git worktrees first. Preserve normal app data and installed app.
For repository worktrees, inspect status, ancestry and active processes; remove
only inactive clean worktrees merged into main. Preserve dirty/unmerged work.

Give READY TO BUMP / NOT READY with concrete gaps. Keep version changes, release
tags, publishing and website work out of this pass. After the bump, verify the
actual signed updater archive, notarized/stapled DMG, downloaded/mounted-app
Gatekeeper assessment, fresh install and update from the previous release.
