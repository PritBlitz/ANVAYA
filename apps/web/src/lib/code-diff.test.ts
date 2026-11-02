import { describe, expect, it } from "vitest";
import {
  citationMarkers,
  codeHref,
  formatLineParam,
  highlightTerms,
  parseLineRange,
  segmentMatches,
  splitLines,
} from "./code";
import { outOfScopeFiles, parseUnifiedDiff } from "./diff";
import { unifiedDiff } from "./api/fixtures/engine";

describe("line ranges", () => {
  it.each([
    ["24-51", { start: 24, end: 51 }],
    ["L24-L51", { start: 24, end: 51 }],
    ["7", { start: 7, end: 7 }],
    ["3–9", { start: 3, end: 9 }],
  ])("parses %s", (input, expected) => {
    expect(parseLineRange(input)).toEqual(expected);
  });

  it.each(["", "0", "9-3", "abc", "1-", null])("rejects %s", (input) => {
    expect(parseLineRange(input)).toBeNull();
  });

  it("round-trips through the URL", () => {
    expect(formatLineParam({ start: 4, end: 4 })).toBe("4");
    expect(codeHref("/w/acme", "r1", "src/a b.ts", { start: 1, end: 3 }, "abc")).toBe(
      "/w/acme/repositories/r1/code?path=src%2Fa+b.ts&lines=1-3&commit=abc",
    );
  });
});

describe("text helpers", () => {
  it("splits lines without a trailing empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });

  it("extracts highlight terms and segments matches case-insensitively", () => {
    const terms = highlightTerms("Where is refresh token expiry handled?");
    expect(terms).toEqual(["refresh", "token", "expiry"]);
    const segs = segmentMatches("isExpired(token) // Token", ["token"]);
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(["token", "Token"]);
    expect(segs.map((s) => s.text).join("")).toBe("isExpired(token) // Token");
  });

  it("treats regex metacharacters in terms literally", () => {
    expect(segmentMatches("a.b axb", ["a.b"]).filter((s) => s.match)).toHaveLength(1);
  });

  it("finds citation markers", () => {
    expect(citationMarkers("See [1] and [12].")).toEqual([1, 12]);
  });
});

describe("unified diff", () => {
  const sample = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+TWO
+two-and-a-half
 three
diff --git a/test/new.ts b/test/new.ts
new file mode 100644
--- /dev/null
+++ b/test/new.ts
@@ -0,0 +1,2 @@
+it("works")
+// end
`;

  it("parses files, statuses, counts and line numbers", () => {
    const files = parseUnifiedDiff(sample);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["test/new.ts", "added", 2, 0],
    ]);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines[1]).toMatchObject({ kind: "del", text: "two", oldNumber: 2, newNumber: null });
    expect(lines[3]).toMatchObject({ kind: "add", text: "two-and-a-half", newNumber: 3 });
    expect(lines[4]).toMatchObject({ kind: "context", oldNumber: 3, newNumber: 4 });
  });

  it("detects deleted and renamed files", () => {
    const files = parseUnifiedDiff(
      `diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n`,
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["old.ts", "deleted"],
      ["b.ts", "renamed"],
    ]);
  });

  it("round-trips with the fixture diff generator", () => {
    const d = unifiedDiff("x.ts", "a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nC\nd\ne\nf\ng\nh\nnew\n");
    const [file] = parseUnifiedDiff(d.text);
    expect(file).toMatchObject({ path: "x.ts", additions: d.additions, deletions: d.deletions });
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
  });

  it("flags files outside the approved scope", () => {
    expect(outOfScopeFiles(["a.ts", "b.ts"], ["a.ts"])).toEqual(["b.ts"]);
  });
});
