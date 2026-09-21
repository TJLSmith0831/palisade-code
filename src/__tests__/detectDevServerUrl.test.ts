import { describe, expect, it } from "vitest";
import { detectDevServerUrl, detectDevServerUrls, localUrlsIn, originOf, sameDevServer } from "../detectDevServerUrl";

describe("detectDevServerUrl", () => {
  it("finds a Vite-style banner", () => {
    expect(detectDevServerUrl("  ➜  Local:   http://localhost:5173/")).toBe(
      "http://localhost:5173/"
    );
  });

  it("takes the last URL when several are printed", () => {
    const banner = "Local: http://127.0.0.1:3000\nNetwork: http://localhost:3001";
    expect(detectDevServerUrl(banner)).toBe("http://localhost:3001/");
  });

  it("strips trailing prose punctuation", () => {
    expect(detectDevServerUrl("listening on http://localhost:8080.")).toBe(
      "http://localhost:8080/"
    );
    expect(detectDevServerUrl("see [http://localhost:3000]")).toBe("http://localhost:3000/");
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
      "http://127.0.0.1:44/"
    );
    const throughLastNewline = "Local: http://127.0.0.1:44".slice(
      0,
      "Local: http://127.0.0.1:44".lastIndexOf("\n") + 1
    );
    expect(detectDevServerUrl(throughLastNewline)).toBe(null);
  });

  it("opens a wildcard bind as localhost — python's default http.server banner", () => {
    expect(detectDevServerUrl("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...")).toBe(
      "http://localhost:8000/"
    );
    expect(detectDevServerUrl("* Listening on http://[::1]:3000")).toBe("http://localhost:3000/");
  });

  it("reads through the colour codes a dev server puts around the port", () => {
    const vite = "  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
    expect(detectDevServerUrl(vite)).toBe("http://localhost:5173/");
  });
});

describe("sameDevServer", () => {
  it("treats a trailing slash as the same server", () => {
    expect(sameDevServer("http://localhost:3000", "http://localhost:3000/")).toBe(true);
    expect(sameDevServer("http://localhost:3000/", "http://localhost:3001/")).toBe(false);
  });
});

describe("localUrlsIn", () => {
  it("returns each URL in a line with where it starts, minus trailing punctuation", () => {
    const line = "Local: http://localhost:5173/, proxy http://127.0.0.1:8080).";
    expect(localUrlsIn(line)).toEqual([
      { start: 7, text: "http://localhost:5173/" },
      { start: 37, text: "http://127.0.0.1:8080" },
    ]);
  });

  it("finds nothing in a line without one", () => {
    expect(localUrlsIn("built in 412ms")).toEqual([]);
  });
});

describe("detectDevServerUrls", () => {
  it("returns every distinct server a message names, as its root", () => {
    expect(detectDevServerUrls("Frontend http://localhost:5173/app, API http://127.0.0.1:8080/api/v1.")).toEqual([
      "http://localhost:5173/",
      "http://127.0.0.1:8080/",
    ]);
  });

  it("names a server once however many times it is mentioned", () => {
    expect(detectDevServerUrls("http://localhost:3000 … open http://localhost:3000/login")).toEqual(["http://localhost:3000/"]);
  });

  it("opens wildcard binds as localhost", () => {
    expect(detectDevServerUrls("Serving on http://0.0.0.0:8000/")).toEqual(["http://localhost:8000/"]);
  });

  it("is empty for text with no local URL", () => {
    expect(detectDevServerUrls("see https://example.com and localhost:3000")).toEqual([]);
  });
});

describe("originOf", () => {
  it("ignores the page path", () => {
    expect(originOf("http://localhost:5173/a/b?c=d")).toBe("http://localhost:5173");
  });
});
