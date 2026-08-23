import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    css: true,
    // Git worktrees live under `.claude/worktrees/` — each is a full checkout
    // of this repo, so without this vitest runs every test file two or three
    // times, once per stale branch, and reports their failures as ours.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
