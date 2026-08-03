#!/usr/bin/env bash
# Build Floo Network.app and install it to /Applications.
#
#   CODESIGN_ID="Floo Network Dev" ./package.sh
#   CODESIGN_ID="Floo Network Dev" ./package.sh --no-install   # build only
#
# Follows day-22-stackwatch/package.sh (commit 83ad83f); the difference is that
# Tauri produces the bundle for us, so this script re-signs Tauri's output
# rather than assembling a bundle by hand.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Floo Network"
BUNDLE_ID="com.tjlsmith0831.floo-network"
APP="src-tauri/target/release/bundle/macos/$APP_NAME.app"

echo "==> building release bundle"
pnpm tauri build

# Guard against Tauri moving its bundler output — without this the script would
# sail past a missing bundle and "successfully" install nothing.
if [[ ! -d "$APP" ]]; then
  echo "error: expected bundle at $APP but it does not exist." >&2
  echo "       Tauri's bundler output path may have changed; check the build log" >&2
  echo "       above for the real path and update APP in this script." >&2
  exit 1
fi

# Finder and iCloud leave extended attributes on copied files, and codesign
# refuses to sign a bundle carrying some of them ("resource fork, Finder
# information, or similar detritus not allowed").
#
# `xattr -cr` alone is not enough: it leaves com.apple.FinderInfo on the bundle
# root, and that is the one codesign actually rejects. This repo lives under
# ~/Desktop, which iCloud manages, so the file-provider daemon keeps applying
# attributes — hence clearing the source icons too, or every build re-inherits
# them. com.apple.provenance survives all of this and is harmless; codesign
# signs fine with it.
xattr -cr assets/icon.png src-tauri/icons/* 2>/dev/null || true
xattr -cr "$APP"
xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
find "$APP" -name '.DS_Store' -delete 2>/dev/null || true

# Signing identity, and why this matters more than it looks.
#
# macOS keys TCC permissions (folder access, automation) to a bundle's
# *designated requirement*. Signed ad-hoc (`-`), that requirement is the cdhash:
#
#     designated => cdhash H"b56bec66..."
#
# a hash of the code — so every rebuild is a different app as far as TCC is
# concerned, and every grant has to be given again. Signed with a real identity
# it becomes
#
#     designated => identifier "com.tjlsmith0831.floo-network" and certificate leaf = H"..."
#
# — bundle id plus certificate, neither of which changes when the code does.
#
# `Floo Network Dev` is a self-signed cert in the login keychain. It does not
# need to be *trusted*: codesign signs happily with an untrusted self-signed
# identity, and nothing here is distributed, so no Gatekeeper check ever
# evaluates it. Each machine generates its own — the certs do not need to match
# across machines, since only per-machine rebuild consistency matters.
#
# To create one (per machine, once):
#
#   # macOS ships LibreSSL, whose `openssl req` has no -addext, so the
#   # extensions go in a config file instead.
#   cat > floo-cert.cnf <<'CNF'
#   [req]
#   distinguished_name = dn
#   x509_extensions    = ext
#   prompt             = no
#   [dn]
#   CN = Floo Network Dev
#   [ext]
#   basicConstraints   = critical,CA:false
#   keyUsage           = critical,digitalSignature
#   extendedKeyUsage   = critical,codeSigning
#   CNF
#   openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 3650 \
#     -nodes -config floo-cert.cnf
#   openssl pkcs12 -export -inkey k.pem -in c.pem -out floo.p12 \
#     -name "Floo Network Dev" -passout pass:PICK_ONE
#   security import floo.p12 -k ~/Library/Keychains/login.keychain-db \
#     -P PICK_ONE -T /usr/bin/codesign
#   rm -f k.pem c.pem floo.p12 floo-cert.cnf   # the key belongs in the keychain
#
# (`-T /usr/bin/codesign`, not `-A`: only codesign may use the key unprompted.)
#
# On first use macOS still puts up a keychain dialog ("codesign wants to use a
# key in your keychain") even with -T, because the key's *partition list* is
# separate from its ACL. Click "Always Allow" once, or set it non-interactively:
#
#   security set-key-partition-list -S apple-tool:,apple:,codesign: \
#     -s -k "<your login password>" ~/Library/Keychains/login.keychain-db
#
# Either way it is a one-time step per machine; later builds sign silently.
CODESIGN_ID="${CODESIGN_ID:--}"
if [[ "$CODESIGN_ID" == "-" ]]; then
  echo "==> WARNING: ad-hoc signing."
  echo "    The designated requirement will be a cdhash, so macOS will treat every"
  echo "    rebuild as a different app and every permission you grant will be"
  echo "    re-requested. Set CODESIGN_ID to a stable identity — see this script's"
  echo "    comments for how to create one."
else
  echo "==> signing as '$CODESIGN_ID'"
fi
# -i pins the signing identifier to the bundle id. Without it codesign derives
# one from the binary name (floo_network-<hash>), which is not what the rest of
# the system knows this app as.
codesign --force --deep --identifier "$BUNDLE_ID" --sign "$CODESIGN_ID" "$APP"

echo "==> designated requirement:"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /    /p'

if [[ "${1:-}" == "--no-install" ]]; then
  echo "==> built $APP (not installed)"
  exit 0
fi

echo "==> installing to /Applications"
rm -rf "/Applications/$APP_NAME.app"
# ditto over cp -R: cp preserves the extended attributes this tree picks up from
# iCloud, and they follow the bundle into /Applications where they make
# `codesign --verify --strict` fail on an app that is otherwise correctly
# signed. Strip again afterwards for anything the copy itself re-applies.
ditto --noextattr --norsrc "$APP" "/Applications/$APP_NAME.app"
xattr -cr "/Applications/$APP_NAME.app" 2>/dev/null || true
xattr -d com.apple.FinderInfo "/Applications/$APP_NAME.app" 2>/dev/null || true

echo "==> verifying the installed bundle"
codesign --verify --deep --strict "/Applications/$APP_NAME.app"
echo "==> done: /Applications/$APP_NAME.app"
