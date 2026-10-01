#!/usr/bin/env bash
# Builds the universal llama.cpp sidecar into src-tauri/. Shared by the tester
# release and its PR dry run, so the dry run proves the exact release steps.
#
# Two slices: the Apple Silicon one uses Metal, the Intel one is CPU-only
# (Metal compute is unavailable on Intel Macs) and is cross-compiled with a
# fixed AVX2 feature set — every Intel Mac that can run macOS 11 has it.
# GGML_NATIVE would otherwise tune the Intel slice to the ARM host's CPU.
# All three files are left in place: tauri-build resolves the per-slice name
# during each `cargo build` and the bundler resolves the universal one.
#
# Static and TLS-free: only the llama-server binary ships, so shared libs
# would be missing at runtime, and the runner's Homebrew OpenSSL is arm64-only
# (it broke the x86_64 link). The sidecar only serves localhost.
set -euo pipefail

# The exact revision of the current local sidecar. A shallow fetch needs the
# full SHA; GitHub refuses an abbreviated one.
LLAMA_CPP_REVISION=308f61c31f083251ce8150f10b9ef97679b500b5
src=vendor/llama.cpp

git init "$src"
if ! git -C "$src" remote get-url origin >/dev/null 2>&1; then
  git -C "$src" remote add origin https://github.com/ggml-org/llama.cpp.git
fi
git -C "$src" fetch --depth=1 origin "$LLAMA_CPP_REVISION"
git -C "$src" checkout --detach FETCH_HEAD

common=(-DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_SERVER=ON -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF)

cmake -S "$src" -B "$src/build-arm64" "${common[@]}" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON
cmake --build "$src/build-arm64" --target llama-server --parallel "${PALISADE_BUILD_JOBS:-2}"

cmake -S "$src" -B "$src/build-x86_64" "${common[@]}" \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_METAL=OFF -DGGML_NATIVE=OFF \
  -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
cmake --build "$src/build-x86_64" --target llama-server --parallel "${PALISADE_BUILD_JOBS:-2}"

install -m 755 "$src/build-arm64/bin/llama-server" src-tauri/llama-server-aarch64-apple-darwin
install -m 755 "$src/build-x86_64/bin/llama-server" src-tauri/llama-server-x86_64-apple-darwin
lipo -create \
  src-tauri/llama-server-aarch64-apple-darwin \
  src-tauri/llama-server-x86_64-apple-darwin \
  -output src-tauri/llama-server-universal-apple-darwin

# Prove both slices exist; readiness testing runs Intel through Rosetta.
src-tauri/llama-server-aarch64-apple-darwin --version
info="$(lipo -info src-tauri/llama-server-universal-apple-darwin)"
echo "$info"
grep -q 'x86_64 arm64\|arm64 x86_64' <<<"$info"

# Only system libraries may be linked; anything else is absent on a user's Mac.
for arch in arm64 x86_64; do
  extra="$(otool -arch "$arch" -L src-tauri/llama-server-universal-apple-darwin |
    tail -n +2 | grep -v -e '/System/Library/' -e '/usr/lib/' || true)"
  [[ -z "$extra" ]] || { echo "llama-server ($arch) links non-system libraries:" >&2; echo "$extra" >&2; exit 1; }
done
