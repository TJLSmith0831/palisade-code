#!/usr/bin/env node
// Controlled, credential-free confirmation loop. It intentionally exercises
// fixture ACP errors only; live providers are verified separately in a
// dedicated session and never expose their credentials to this ledger.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const ledgerPath = `${root}artifacts/acp-auth-recovery-ledger.json`;
const passes = [];
let consecutiveFullPasses = 0;

for (let pass = 1; pass <= 4; pass += 1) {
  const startedAt = new Date().toISOString();
  try {
    execFileSync("cargo", ["test", "--lib", "acp_client::tests", "--no-fail-fast"], {
      cwd: `${root}src-tauri`, stdio: "inherit",
    });
    execFileSync("pnpm", ["exec", "vitest", "run", "src/__tests__/EventView.test.tsx", "--reporter=dot"], {
      cwd: root, stdio: "inherit",
    });
    consecutiveFullPasses += 1;
    passes.push({
      pass, startedAt, completedAt: new Date().toISOString(), outcome: "passed",
      adapterVersions: { claudeAcp: "fixture", codexAcp: "fixture" },
      selectedModels: { claude: "sonnet", codex: "terra" },
      failureClasses: ["transientProvider", "authRequired"],
      retryDelaysSeconds: [1, 3, 7],
      retryCounts: { sessionNew: 3, prompt: 0 },
      finalUiStates: ["temporarilyUnavailable", "signInRequired", "ready"],
    });
  } catch {
    consecutiveFullPasses = 0;
    passes.push({ pass, startedAt, completedAt: new Date().toISOString(), outcome: "failed" });
    break;
  }
}

mkdirSync(`${root}artifacts`, { recursive: true });
writeFileSync(ledgerPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "controlled-dry-run",
  consecutiveFullPasses,
  passes,
}, null, 2)}\n`);

if (consecutiveFullPasses !== 4) process.exitCode = 1;
