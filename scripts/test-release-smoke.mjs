import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Execute the real workflow step, replacing only HTTP and retry delays.
const workflow = readFileSync(new URL("../.github/workflows/tester-release.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Smoke-test the published update manifest\n")[1]
  .split("        run: |\n")[1].split("\n      - name:")[0]
  .replace(/^          /gm, "");
const manifest = {
  version: "0.5.1",
  platforms: Object.fromEntries(["darwin-universal", "darwin-aarch64", "darwin-x86_64"]
    .map((key) => [key, { signature: "SIG", url: "https://w.dev/download/111" }])),
};

function run(responses) {
  const dir = mkdtempSync(join(tmpdir(), "release-smoke-"));
  try {
    responses.forEach((response, i) => {
      if (response !== null) writeFileSync(join(dir, `${i + 1}.json`), JSON.stringify(response));
    });
    const result = spawnSync("bash", ["-c", `
      calls=0
      curl() {
        calls=$((calls + 1))
        printf '%s' "$calls" > "$RUNNER_TEMP/calls"
        for arg in "$@"; do
          if [[ "$arg" == https://* ]]; then printf '%s\\n' "$arg" >> "$RUNNER_TEMP/urls"; fi
        done
        [[ -f "$RUNNER_TEMP/$calls.json" ]] || return 22
        cp "$RUNNER_TEMP/$calls.json" "$RUNNER_TEMP/latest.json"
      }
      sleep() { :; }
      ${step}
    `], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: dir, EXPECTED_VERSION: "v0.5.1" } });
    return {
      ...result,
      calls: Number(readFileSync(join(dir, "calls"), "utf8")),
      urls: readFileSync(join(dir, "urls"), "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("release smoke test waits for the published version after a stale HTTP 200", () => {
  const result = run([{ ...manifest, version: "0.4.1" }, manifest]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 2);
  assert.equal(new Set(result.urls).size, 2, "each retry must bypass cached stale responses");
});

test("release smoke test retries HTTP failures before validating the manifest", () => {
  const result = run([null, manifest]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 2);
});

test("release smoke test succeeds immediately for a complete manifest", () => {
  const result = run([manifest]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 1);
});

test("release smoke test rejects a persistently stale or incomplete manifest", () => {
  for (const response of [{ ...manifest, version: "0.4.1" }, { ...manifest, platforms: {} }]) {
    const result = run(Array(12).fill(response));
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, 12);
  }
});
