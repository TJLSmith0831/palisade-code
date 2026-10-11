# Shared by dev and local packaging; release distribution signing is selected separately.
if [[ -z "${CODESIGN_ID:-}" ]]; then
  # Apple-issued identities use a stable team partition; self-signed identities use cdhash.
  CODESIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null |
    awk '/"(Developer ID Application|Apple Development):/ { if (!found) print $2; found=1 }')" || CODESIGN_ID=""
  if [[ -z "$CODESIGN_ID" ]]; then
    if security find-certificate -c "Palisade Code Dev" >/dev/null 2>&1; then
      CODESIGN_ID="Palisade Code Dev"
    else
      CODESIGN_ID="-"
    fi
  fi
fi
if [[ "$CODESIGN_ID" == "-" ]]; then
  echo "signing: ad-hoc identity; rebuilds may request permissions again. See package.sh for setup." >&2
elif [[ "$CODESIGN_ID" == "Palisade Code Dev" ]]; then
  echo "signing: self-signed identity; Keychain can prompt again after each rebuild. Use an Apple-issued CODESIGN_ID for stable Keychain access." >&2
fi
