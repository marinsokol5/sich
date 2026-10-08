import { describe, expect, test } from "bun:test";
import { normalizeClaims } from "../src/claims";
import { baseExcludeLines, escapePattern, layerExcludeLines, spliceBlock, BLOCK_BEGIN, BLOCK_END } from "../src/excludes";

describe("layer whitelist", () => {
  test("re-opens the parent chain of a nested file", () => {
    expect(layerExcludeLines("notes", ["a/b/c.md"], [])).toEqual([
      "/*",
      "!/.sich/",
      "/.sich/*",
      "!/.sich/notes.paths",
      "!/a/",
      "/a/*",
      "!/a/b/",
      "/a/b/*",
      "!/a/b/c.md",
    ]);
  });

  test("shared parents: every /dir/* precedes the re-includes of its children, no duplicates", () => {
    const lines = layerExcludeLines("n", ["a/x.md", "a/b/c.md", "a/b/d/", "top.md"], []);
    expect(lines).toEqual([
      "/*",
      "!/.sich/",
      "/.sich/*",
      "!/.sich/n.paths",
      "!/a/",
      "/a/*",
      "!/a/b/",
      "/a/b/*",
      "!/a/b/c.md",
      "!/a/b/d/",
      "!/a/x.md",
      "!/top.md",
    ]);
    expect(new Set(lines).size).toBe(lines.length);
    // Each "!/<dir>/<child>" must come after "/<dir>/*".
    lines.forEach((l, i) => {
      const m = /^!\/(.+)\/[^/]+\/?$/.exec(l);
      if (m) expect(lines.indexOf(`/${m[1]}/*`)).toBeLessThan(i);
    });
  });

  test("a directory claim absorbs claims beneath it", () => {
    expect(layerExcludeLines("n", ["docs/a.md", "docs/"], [])).toContain("!/docs/");
    expect(layerExcludeLines("n", ["docs/a.md", "docs/"], [])).not.toContain("!/docs/a.md");
  });

  test("other layers' nested claims are carved out, their ancestor claims are not", () => {
    const notes = layerExcludeLines("notes", ["docs/"], ["docs/api.env", ".env"]);
    expect(notes.slice(-2)).toEqual(["/.env", "/docs/api.env"]);
    const keys = layerExcludeLines("keys", ["docs/api.env", ".env"], ["docs/"]);
    expect(keys).not.toContain("/docs/");
    expect(keys).toContain("!/docs/api.env");
  });

  test("glob characters are escaped", () => {
    expect(escapePattern("we*rd[1]?.md")).toBe("we\\*rd\\[1]\\?.md");
    expect(layerExcludeLines("n", ["a*/b.md"], [])).toContain("!/a\\*/b.md");
  });
});

describe("base block", () => {
  test("excludes .sich/ and every claim, anchored", () => {
    expect(baseExcludeLines(["roadmap/", "NOTES.md", "NOTES.md"])).toEqual(["/.sich/", "/NOTES.md", "/roadmap/"]);
  });
});

describe("spliceBlock", () => {
  test("appends, then replaces in place, preserving user lines", () => {
    const user = "# user stuff\n*.log";
    const once = spliceBlock(user, ["/a"]);
    expect(once).toBe(`# user stuff\n*.log\n${BLOCK_BEGIN}\n/a\n${BLOCK_END}\n`);
    const withTail = once + "after\n";
    const twice = spliceBlock(withTail, ["/b"]);
    expect(twice).toBe(`# user stuff\n*.log\n${BLOCK_BEGIN}\n/b\n${BLOCK_END}\nafter\n`);
    expect(spliceBlock(twice, ["/b"])).toBe(twice);
  });
});

describe("normalizeClaims", () => {
  test("dedupes, sorts, absorbs, prefers the directory form", () => {
    expect(normalizeClaims(["b.md", "a/", "a/x", "b.md", "c", "c/"])).toEqual(["a/", "b.md", "c/"]);
  });
});
