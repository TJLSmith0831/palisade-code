# Handoff: `./package.sh` fails at updater-artifact signing

**Repo:** `/Users/tjlsmith0831/dev/palisade-code` (branch `main`, macOS/aarch64)
**Status:** one blocker, needs a secret only the user has.
**Scope:** do **not** re-do the bug fixes or the codesign identity — both are done and verified.

---

## The blocker, in one line

`./package.sh` aborts inside `pnpm tauri build` because Tauri cannot decrypt the
**updater signing key** — the passphrase stored in the login keychain is wrong.

```
failed to decode secret key: incorrect updater private key password: Wrong password for that key
       Error failed to decode secret key: incorrect updater private key password: Wrong password for that key
 ELIFECYCLE  Command failed with exit code 1.
```

## Why it stops the whole script

`package.sh` is `set -euo pipefail` (line 18) and runs `pnpm tauri build` (line ~42)
*before* it reaches any codesigning. So the build failure kills the script before
the signing logic ever executes. This is **pre-existing** — it is not caused by the
uncommitted `package.sh` edits described below, and it predates this session.

The trigger is in `src-tauri/tauri.conf.json`:

- line 53 — `"createUpdaterArtifacts": true`
- line 57 — `"pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6..."`

With a pubkey configured, `tauri build` signs `Palisade.app.tar.gz` itself and
fails the build if it cannot.

## Evidence that the plumbing is correct and only the secret is wrong

The error message changed as the inputs changed. This is the useful diagnostic:

| Condition | Error |
|---|---|
| No env var set at all | `A public key has been found, but no private key. Make sure to set TAURI_SIGNING_PRIVATE_KEY` |
| Key path set, no passphrase | `incorrect updater private key password: Device not configured (os error 6)` |
| Key path + passphrase from keychain | `incorrect updater private key password: **Wrong password for that key**` |

The third row proves `package.sh` **successfully reads the keychain and passes the
value through to Tauri**. The wiring works. The stored passphrase simply does not
match the key. Do not go re-debugging the env plumbing.

## Current state of the moving parts

- Key file: `~/.tauri/palisade.key` — exists, 348 bytes, mode `600`, single-line
  base64, passphrase-protected. **Do not decode or print it.**
- Keychain item: generic password, service `palisade-updater-key` — **exists but
  holds the wrong value** (the user entered it once; it did not match).
- `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`: not set in the user's shell;
  `package.sh` now derives both (see below).

---

## What to do

### Step 1 — get the correct passphrase (blocking, user-only)

Only the user has it. Ask them to re-store it; **never handle, print, echo, or
ask them to paste the passphrase into the conversation.** `-w` with no argument
prompts silently in their terminal:

```bash
security delete-generic-password -s palisade-updater-key
security add-generic-password -a "$USER" -s palisade-updater-key -w
```

Confirm it landed without reading it:

```bash
security find-generic-password -s palisade-updater-key >/dev/null 2>&1 && echo stored
```

### Step 2 — verify

```bash
cd /Users/tjlsmith0831/dev/palisade-code && ./package.sh --no-install
```

Expect: `==> signing as 'Palisade Code Dev'` followed by

```
designated => identifier "com.tjlsmith0831.palisade-code" and certificate leaf = H"2ccd4d20..."
```

### Step 3 — commit

`package.sh` is the **only** uncommitted file that belongs to this work
(+45/−6). Commit it once step 2 is green.

> The ~25 modified/untracked paths under `openspec/` were already in the working
> tree before this work began. They are **not** part of this change — leave them
> alone and do not stage them.

### If the passphrase is unrecoverable

Generating a new updater keypair (`pnpm tauri signer generate`) changes `pubkey`
in `tauri.conf.json`, which **breaks auto-update for every existing tester** —
they would each need a manual reinstall. Treat that as a last resort and get
explicit user sign-off first. There is no way to recover a lost minisign
passphrase.

---

## Uncommitted `package.sh` changes (context, already written and syntax-checked)

Two edits, both above the failure point except where noted:

1. **Codesign identity now defaults to `Palisade Code Dev`.** The old default was
   ad-hoc (`-`), so a bare `./package.sh` silently re-signed with a cdhash
   designated requirement and reset every TCC grant. Falls back to ad-hoc (with a
   loud warning) on a machine that has no such certificate, so a fresh clone still
   builds. All four branches were tested: bare+identity → identity; `CODESIGN_ID=-`
   → ad-hoc; custom id → respected; bare+no identity → ad-hoc.
2. **Updater key/passphrase are now derived automatically** — key path defaults to
   `~/.tauri/palisade.key`, passphrase comes from the keychain lookup. Both remain
   overridable from the environment for CI. Emits a warning rather than failing
   silently when either is missing.

**No secret is stored in `package.sh`.** Line ~48 is a `security
find-generic-password` *call*; the value lives only in the keychain and only in
memory during a build. The user asked about this directly — worth being able to
reassure them again.

---

## Already done — do not redo

- **Six reported bugs + two found in passing**, fixed, tested and pushed to `main`:
  `b5cb000` (fixes) and `102f47b` (dead-CSS cleanup + guard-test repoint).
  Gate at time of push: 880 frontend tests, 669 Rust tests, typecheck clean, build clean.
- **Codesign identity `Palisade Code Dev`** created in the login keychain and
  verified. Designated requirement is now
  `identifier "com.tjlsmith0831.palisade-code" and certificate leaf = H"2ccd4d20…"`,
  proven stable across a simulated rebuild (modified the code so the cdhash
  necessarily differed, re-signed, requirement came back byte-identical).
  TCC grants will no longer reset. `spctl --assess` reporting `rejected` is
  expected and harmless — that is Gatekeeper wanting notarization, which only
  applies to distributed builds.
- **`/Applications/Palisade.app` is current, working, and correctly signed.** It
  was produced with `pnpm tauri build` + a manual `codesign`, bypassing
  `package.sh`. Installed-vs-built binary hashes were compared and matched.

## Important nuance about "the build fails"

`pnpm tauri build` **still produces a complete, correct `Palisade.app` and
`.dmg`** — bundling finishes *before* the updater-signing step that fails. So the
non-zero exit does not mean the app artifact is bad. What is missing is the signed
`Palisade.app.tar.gz` updater artifact.

Consequence: distribution via the **updater** is blocked until step 1 is resolved;
distribution via the **.dmg** is not.

A caution for whoever picks this up: earlier in this session I reported some of
these builds as "exit 0". That was wrong — the `0` came from a trailing `echo` in
a compound command, not from `pnpm tauri build`. Every release build in the session
hit this same updater error. Check `${PIPESTATUS[0]}` or run the build bare;
do not trust a wrapped exit code here.

## Fast repro

```bash
cd /Users/tjlsmith0831/dev/palisade-code
./package.sh --no-install; echo "exit=$?"
# -> exit=1, "incorrect updater private key password: Wrong password for that key"
```
