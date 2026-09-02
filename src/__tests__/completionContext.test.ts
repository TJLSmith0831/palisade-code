import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_FILES,
  extractImportSpecifiers,
  gatherContext,
  recentEdits,
  recordEdit,
  resetRecentEdits,
} from "../completion/context";

describe("recordEdit", () => {
  beforeEach(() => resetRecentEdits());

  it("returns the most recently edited file first", () => {
    recordEdit("a.ts");
    recordEdit("b.ts");
    expect(recentEdits()).toEqual(["b.ts", "a.ts"]);
  });

  it("re-editing a file moves it to the front rather than duplicating it", () => {
    recordEdit("a.ts");
    recordEdit("b.ts");
    recordEdit("a.ts");
    expect(recentEdits()).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps the list bounded so a long session cannot grow it forever", () => {
    for (let i = 0; i < 50; i++) recordEdit(`f${i}.ts`);
    expect(recentEdits().length).toBeLessThanOrEqual(16);
    expect(recentEdits()[0]).toBe("f49.ts");
  });
});

describe("extractImportSpecifiers", () => {
  it("finds relative TypeScript imports and ignores bare package names", () => {
    const src = [
      `import { Item } from "./models";`,
      `import helper from '../util/helper';`,
      `import React from "react";`,
    ].join("\n");
    // Bare specifiers resolve to node_modules, never to a project file.
    expect(extractImportSpecifiers(src)).toEqual(["./models", "../util/helper"]);
  });

  it("finds Python relative and absolute module imports", () => {
    const src = ["from .models import Item", "import util.helpers", "from typing import List"].join(
      "\n"
    );
    const found = extractImportSpecifiers(src);
    expect(found).toContain(".models");
    expect(found).toContain("util.helpers");
  });

  it("finds Rust crate-local modules", () => {
    const src = ["use crate::store::Res;", "use std::io::Read;"].join("\n");
    const found = extractImportSpecifiers(src);
    expect(found).toContain("crate::store");
    // std is the toolchain's, not the project's.
    expect(found.some((f) => f.startsWith("std"))).toBe(false);
  });

  it("returns nothing for a file with no imports", () => {
    expect(extractImportSpecifiers("const x = 1;\n")).toEqual([]);
  });
});

describe("gatherContext", () => {
  const contentFor = (p: string) =>
    ({
      "src/models.ts": "export class Item {}",
      "src/util/helper.ts": "export const helper = () => {};",
      "src/other.ts": "export const other = 1;",
      "src/edited.ts": "export const edited = 2;",
    })[p];

  beforeEach(() => resetRecentEdits());

  it("never includes the file being edited", () => {
    const files = gatherContext({
      currentPath: "src/models.ts",
      currentText: "",
      openPaths: ["src/models.ts", "src/other.ts"],
      contentFor,
    });
    expect(files.map((f) => f.path)).not.toContain("src/models.ts");
  });

  it("ranks a file the current file imports above a merely-open file", () => {
    const files = gatherContext({
      currentPath: "src/main.ts",
      currentText: `import { Item } from "./models";`,
      openPaths: ["src/other.ts", "src/models.ts"],
      contentFor,
    });
    // An imported type is the case the model most often cannot complete
    // against, so it outranks a file that merely happens to be open.
    expect(files[0].path).toBe("src/models.ts");
  });

  it("falls back to open tabs and recent edits when there are no imports", () => {
    recordEdit("src/edited.ts");
    const files = gatherContext({
      currentPath: "src/main.ts",
      currentText: "const x = 1;",
      openPaths: ["src/other.ts"],
      contentFor,
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/other.ts");
    expect(paths).toContain("src/edited.ts");
  });

  it("lists each file once even when it is open, imported and recently edited", () => {
    recordEdit("src/models.ts");
    const files = gatherContext({
      currentPath: "src/main.ts",
      currentText: `import { Item } from "./models";`,
      openPaths: ["src/models.ts"],
      contentFor,
    });
    expect(files.filter((f) => f.path === "src/models.ts")).toHaveLength(1);
  });

  it("caps the file count so the prompt budget is not blown on the hot path", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const files = gatherContext({
      currentPath: "src/main.ts",
      currentText: "",
      openPaths: many,
      contentFor: () => "x",
    });
    expect(files.length).toBeLessThanOrEqual(MAX_CONTEXT_FILES);
  });

  it("skips files whose content is not loaded rather than sending empty ones", () => {
    const files = gatherContext({
      currentPath: "src/main.ts",
      currentText: "",
      openPaths: ["src/not-loaded.ts", "src/other.ts"],
      contentFor,
    });
    expect(files.map((f) => f.path)).toEqual(["src/other.ts"]);
  });
});
