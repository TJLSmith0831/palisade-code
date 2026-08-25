import { describe, expect, it } from "vitest";
import { detectDevServerUrl } from "../detectDevServerUrl";

describe("detectDevServerUrl", () => {
  it("finds a Vite-style banner", () => {
    expect(detectDevServerUrl("  ➜  Local:   http://localhost:5173/")).toBe(
      "http://localhost:5173/"
    );
  });

  it("takes the last URL when several are printed", () => {
    const banner = "Local: http://127.0.0.1:3000\nNetwork: http://localhost:3001";
    expect(detectDevServerUrl(banner)).toBe("http://localhost:3001");
  });

  it("strips trailing prose punctuation", () => {
    expect(detectDevServerUrl("listening on http://localhost:8080.")).toBe(
      "http://localhost:8080"
    );
  });

  it("reads the URL out of a python http.server banner", () => {
    expect(
      detectDevServerUrl(
        "Serving HTTP on 127.0.0.1 port 4401 (http://127.0.0.1:4401/) ...\n"
      )
    ).toBe("http://127.0.0.1:4401/");
  });

  it("ignores output with no local URL", () => {
    expect(detectDevServerUrl("built in 412ms\nsee https://example.com")).toBe(
      null
    );
  });

  // A PTY chunk can end mid-URL. The caller only ever hands over complete
  // lines for exactly this reason — a truncated match reads as a different
  // URL, so it slips past dedup and navigates to a half-typed port.
  it("would match a truncated URL, which is why callers scan whole lines only", () => {
    expect(detectDevServerUrl("Local: http://127.0.0.1:44")).toBe(
      "http://127.0.0.1:44"
    );
    const throughLastNewline = "Local: http://127.0.0.1:44".slice(
      0,
      "Local: http://127.0.0.1:44".lastIndexOf("\n") + 1
    );
    expect(detectDevServerUrl(throughLastNewline)).toBe(null);
  });
});
