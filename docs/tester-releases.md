# Tester releases

Local development never publishes an update. `./package.sh` only builds and,
unless passed `--no-install`, installs an app on the current Mac. It neither
needs nor reads updater credentials.

Tester releases start when a `vX.Y.Z` tag is pushed. The tag must match the
versions in `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`. The workflow runs its checks first, then waits for an
approval on the GitHub **testers** environment. Only that approved job can read
release credentials or publish a GitHub prerelease.

## One-time GitHub setup

Create an environment named `testers`, restrict deployments to tags matching
`v*`, and require a reviewer. Add these environment secrets:

| Secret                               | Value                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | The existing updater private key, as file contents. Never replace it while existing installs need updates. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase for that updater key.                                                                           |
| `APPLE_CERTIFICATE_BASE64`           | Base64 encoding of the Developer ID Application `.p12` certificate.                                        |
| `APPLE_CERTIFICATE_PASSWORD`         | Password used to export that `.p12`.                                                                       |
| `APPLE_SIGNING_IDENTITY`             | Developer ID Application signing identity.                                                                 |
| `APPLE_API_KEY_BASE64`               | Base64 encoding of the App Store Connect API `.p8` file.                                                   |
| `APPLE_API_KEY_ID`                   | App Store Connect API key ID.                                                                              |
| `APPLE_API_ISSUER`                   | App Store Connect API issuer UUID.                                                                         |
| `HF_TOKEN`                           | Read-only Hugging Face token for `TJLSmith0831/palisade-models`.                                           |

The workflow builds the pinned `llama.cpp` sidecar from source for both Apple
Silicon (Metal) and Intel (CPU-only), lipo's it, and verifies the model
checksum before packaging a universal app. It then publishes three assets:
the signed updater archive and signature for existing testers, plus a
notarized, model-included universal DMG for a tester's first install. One
download contains both architectures and targets macOS 11 up. Current support
is Apple Silicon; the Intel slice is not runtime-verified and must not be
advertised as supported until a real Intel tester validates it.

After publication, the existing update Worker reads that prerelease and serves
it to installed tester apps. A failed or unapproved workflow cannot change what
testers receive.
