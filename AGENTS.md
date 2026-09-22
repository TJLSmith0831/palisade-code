# Day 23 — Palisade Code — AGENTS.md
Cross-machine agent harness: compiled-in agents (Claude Code or Codex) drive both spec-mode (read-only/plan, grill-explore/grill-propose) and go-mode (write-enabled, grill-apply), keeping project threads and session history in sync. Sessions are concurrent and individually identified — a thread can hold several at once.

## Stack
Rust + Tauri · TypeScript (frontend) · pnpm · Browserbase (web search) · Claude Code / Codex CLI

## Commands (verified 2026-08-03)
- `pnpm install` — install frontend dependencies (run from the repo root)
- `cd src-tauri && cargo test` — run Rust backend tests
- `pnpm start` (= `pnpm tauri dev`) — start the Tauri dev window
- `pnpm build` — typecheck (`tsc`) and build the frontend bundle
- `pnpm tauri build` — create the release binary

## Packaging (per machine, local dev)
`CODESIGN_ID="Palisade Code Dev" ./package.sh` — builds the release bundle,
re-signs it with a stable self-signed identity, and installs it to
`/Applications`. `--no-install` builds without installing.

Without `CODESIGN_ID` the bundle is ad-hoc signed, so its designated
requirement is a cdhash that changes every rebuild and macOS re-prompts for
every permission it was already granted. `package.sh`'s comments carry the
exact one-time commands to create the identity on a new machine (note macOS
ships LibreSSL, whose `openssl req` has no `-addext` — the extensions go in a
config file). Each machine generates its own identity; they don't need to
match, since only per-machine rebuild consistency matters.

First signing on a machine raises a keychain dialog even with
`-T /usr/bin/codesign`; click "Always Allow" once, or set the key partition
list as documented in the script.

## Releasing (signed, notarized .dmg)
Distribution is a different path from the self-signed one above: it needs a
paid Apple Developer Program membership, a *Developer ID Application*
certificate (Xcode > Settings > Accounts > Manage Certificates, requires
Admin/Account Holder), and an App Store Connect API key (`.p8`) for
notarization. Keep the `.p8` at `~/private_keys/` with mode 600 — it is a
private key and must never enter the repo.

    APPLE_SIGNING_IDENTITY="Developer ID Application: NAME (TEAMID)" \
    APPLE_API_KEY="<key-id>" \
    APPLE_API_ISSUER="<issuer-uuid>" \
    APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_<key-id>.p8" \
    ./package.sh --no-install

With `APPLE_SIGNING_IDENTITY` set, `package.sh` skips its manual re-sign step:
Tauri has already signed the bundle *and* the nested `llama-server` sidecar
with the hardened runtime and `src-tauri/entitlements.plist`. Re-signing with
`--deep` would clobber the sidecar's signature and fail notarization.

**Tauri notarizes and staples the `.app`, not the `.dmg`.** The dmg is built
afterwards and is a separate artifact with its own hash, so it needs its own
submission or downloaders hit Gatekeeper on the disk image itself:

    xcrun notarytool submit <path-to-dmg> --key ... --key-id ... --issuer ... --wait
    xcrun stapler staple <path-to-dmg>

Verify the way a downloader sees it — mount the dmg and check the app inside,
not the build-tree copy. `spctl -a -vvv -t install <mounted>/Palisade.app`
must report `accepted` / `source=Notarized Developer ID`.

### Gotchas
- **Notarization takes ~1 hour**, and that is normal here. The bundle is 528MB
  and 517MB of it is `resources/models/*.gguf` — notary time scales with bytes
  uploaded and hashed. The model is data, not code, so it draws no findings;
  it just makes every round trip slow. Notarize once per *release*, not per
  build; the inner loop is `pnpm start` and the self-signed `CODESIGN_ID` path,
  neither of which contacts Apple.
- **The entitlements exist for the sidecar.** `allow-jit` (llama.cpp compiles
  Metal shaders at runtime) and `disable-library-validation` (it loads its own
  dylibs). Without them the hardened runtime kills `llama-server` at launch.
- **Released builds are universal (Apple Silicon + Intel).** The tag-driven
  workflow passes `--target universal-apple-darwin` and builds the sidecar
  twice (Metal on arm64, CPU-only AVX2 on x86_64) before lipo'ing it. Local
  `package.sh` builds stay host-arch only: they use whatever
  `llama-server-<triple>` sits in `src-tauri/`, and a dev machine has one.

## Verifying UI flows
Playwright cannot drive this app: it targets Chromium/Firefox/WebKit browsers,
not the WKWebView that Tauri embeds on macOS. Use the Tauri MCP instead — the
debug-only `tauri-plugin-mcp-bridge` is registered under `cfg(debug_assertions)`
and serves a WebSocket bridge on `127.0.0.1:9223` once `pnpm start` is running,
which drives the real binary against the real Rust backend.

## Concept
Two-mode harness that moves from spec to tested code, both modes driven by the same detected executor (Claude Code or Codex). Spec-mode (default) runs the executor in a read-only/plan permission mode (`--permission-mode plan` for Claude, `--sandbox read-only` for Codex) and focuses on grill-explore / grill-propose skills, note-taking, and research — no implementation writes. Go-mode runs the executor in a write-enabled permission mode (`--permission-mode default` for Claude, `--sandbox workspace-write` for Codex) and focuses on grill-apply or direct implementation. `/go` starts a go-mode session *alongside* any live spec session rather than terminating it: mode is intent on the thread and enforcement on the session, so a thread can run both at once and stopping is a per-session action. A new session with the same agent carries the conversation forward via that agent's own resume handle (no summarization call); a *different* agent cannot — resume handles are provider-private — so it starts fresh. Project-level detection lets one harness instance carry many threads; session history persists across restarts as append-only `SessionRecord`s.

## Gotchas
- **Executor detection is machine-specific.** Personal laptop expects `claude`; work laptop expects `codex`. Detection must tolerate aliases, PATH variations, and missing executables. If both are present, prefer `claude`; if neither, warn and stay in chat-only mode.
- **Browserbase key lives in `.env`.** Load with `dotenv`; never commit the key or read `.env` contents into logs.
- **Session store must live outside target repos.** Default to a dotdir under the user's home (e.g. `~/.palisade-code/sessions/`) so project git histories stay clean.
- **Notes are files inside the project.** The harness proposes a path under the project root; the user confirms before any write. Never create files outside the project root.
- **Two modes share the executor but differ in permission mode and skill focus.** Spec-mode runs the executor read-only/plan (`--permission-mode plan` for Claude, `--sandbox read-only` for Codex) and focuses on grill-explore/grill-propose. Go-mode runs the executor write-enabled (`--permission-mode default` for Claude, `--sandbox workspace-write` for Codex) and focuses on grill-apply. `/go` terminates the spec-mode executor and spawns a fresh go-mode executor with conversation history carried forward — no summarization call.
- **Tool permissions are enforced by the executor, not a harness dispatcher.** With a full executor CLI, the executor runs its own internal tool loop — the harness can't easily intercept individual tool calls. Enforcement shifts to the executor's built-in `--permission-mode`/`--sandbox`. The custom `create_note` approval gate and bash two-tier policy from the earlier Gemma-based design are no longer harness-side; whether they can be restored via executor-level hooks (Claude Code hooks, Codex plugins) is an open question for grill-apply.
- **Ponytail is a plugin installed inside Claude Code/Codex, not a binary the harness invokes.** It's a one-time per-machine setup (`/plugin install ponytail@ponytail` in each tool), not a handoff-time step. Before dispatching a handoff, the harness should check that the detected executor has Ponytail installed and warn if it's missing, since the harness itself has no way to install it into another program's plugin system.
