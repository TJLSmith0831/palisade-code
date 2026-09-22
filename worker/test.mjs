// Run: node worker/test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpdateManifest } from "./src/index.js";

const release = {
  tag_name: "v0.2.1",
  body: "fixed the thing",
  published_at: "2026-08-30T12:00:00Z",
  assets: [
    { id: 111, name: "Palisade.app.tar.gz" },
    { id: 112, name: "Palisade.app.tar.gz.sig" },
    { id: 113, name: "Palisade_0.2.1_universal.dmg" },
  ],
};

const TARGETS = "darwin-universal darwin-aarch64";

test("manifest matches the shape Tauri validates", () => {
  const m = buildUpdateManifest(release, TARGETS, "https://w.dev", "SIG");

  assert.equal(m.version, "0.2.1", "the leading v must be stripped");
  assert.equal(m.platforms["darwin-universal"].signature, "SIG");
  assert.equal(m.platforms["darwin-universal"].url, "https://w.dev/download/111");
});

// Installs from the aarch64-only era still ask for darwin-aarch64; the
// universal archive runs there, so it is offered under that key too.
test("the one archive is offered under every configured platform key", () => {
  const m = buildUpdateManifest(release, TARGETS, "https://w.dev", "SIG");
  assert.deepEqual(Object.keys(m.platforms).sort(), ["darwin-aarch64", "darwin-universal"]);
  assert.deepEqual(m.platforms["darwin-aarch64"], m.platforms["darwin-universal"]);
});

test("the dmg is never offered as the update payload", () => {
  const m = buildUpdateManifest(release, TARGETS, "https://w.dev", "SIG");
  assert.ok(!m.platforms["darwin-universal"].url.endsWith("/113"));
});

test("a release without an app archive fails loudly", () => {
  const dmgOnly = { ...release, assets: [{ id: 113, name: "Palisade.dmg" }] };
  assert.throws(() => buildUpdateManifest(dmgOnly, TARGETS, "https://w.dev", "SIG"), /no \.app\.tar\.gz/);
});

test("an empty target list fails loudly rather than publishing no platforms", () => {
  assert.throws(() => buildUpdateManifest(release, "", "https://w.dev", "SIG"), /no update targets/);
});

import { parseModels } from "./src/index.js";

const TABLE = `
fim  | fim/Qwen3.5-0.8B.Q4_K_M.gguf | abc123 | 517000000 | 0.2.0
chat | chat/Qwen3.5-4B.Q4_K_M.gguf  |        |           |
`;

test("the models table parses into roles", () => {
  const models = parseModels(TABLE);

  assert.deepEqual(Object.keys(models).sort(), ["chat", "fim"]);
  assert.equal(models.fim.path, "fim/Qwen3.5-0.8B.Q4_K_M.gguf");
  assert.equal(models.fim.filename, "Qwen3.5-0.8B.Q4_K_M.gguf", "the folder must not leak into the local filename");
  assert.equal(models.fim.size, 517000000);
  assert.equal(models.chat.sha256, "", "a blank column is empty, not undefined");
});

test("blank lines and comments are skipped", () => {
  assert.deepEqual(parseModels("\n\n# fim | nope | x | 1 | 0\n"), {});
  assert.deepEqual(parseModels(""), {});
  assert.deepEqual(parseModels(undefined), {});
});
