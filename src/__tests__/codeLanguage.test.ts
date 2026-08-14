import { describe, expect, it } from "vitest";
import { languageExtensionFor, languageLabelFor } from "../codeLanguage";

describe("languageExtensionFor", () => {
  it("maps common extensions to a non-empty extension list", () => {
    const cases = [
      "src/main.rs",
      "src/app.js",
      "src/app.jsx",
      "src/app.ts",
      "src/app.tsx",
      "scripts/run.py",
      "cmd/main.go",
      "data/config.json",
      "README.md",
      "styles/app.css",
    ];
    for (const path of cases) {
      expect(languageExtensionFor(path).length).toBeGreaterThan(0);
    }
  });

  it("falls back to a plain-text (empty) extension for unrecognized types", () => {
    expect(languageExtensionFor("data/file.xyz")).toEqual([]);
    expect(languageExtensionFor("Makefile")).toEqual([]);
  });

  it("is case-insensitive on the extension", () => {
    expect(languageExtensionFor("src/Main.RS").length).toBeGreaterThan(0);
  });
});

describe("languageLabelFor", () => {
  it("names the language the status bar shows", () => {
    expect(languageLabelFor("src/App.tsx")).toBe("TypeScript");
    expect(languageLabelFor("main.rs")).toBe("Rust");
    expect(languageLabelFor("a.yml")).toBe("YAML");
  });

  it("falls back to the extension rather than lying about plain text", () => {
    expect(languageLabelFor("data.parquet")).toBe("PARQUET");
  });

  it("calls an extensionless file plain text", () => {
    expect(languageLabelFor("Makefile")).toBe("Plain text");
  });

  it("has no label without a file", () => {
    expect(languageLabelFor(null)).toBeNull();
  });
});
