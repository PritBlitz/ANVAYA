import { describe, expect, it } from "vitest";
import { tokenizeLines, type Token } from "./syntax";

const kinds = (t: Token[]) => t.filter((x) => x.kind !== "plain").map((x) => `${x.kind}:${x.text}`);

describe("syntax tokenizer (FD-8)", () => {
  it("highlights TypeScript keywords, strings, numbers, calls and types", () => {
    const [line] = tokenizeLines(
      ['export const x: Money = round("a\\"b", 42); // done'],
      "typescript",
    )!;
    expect(kinds(line!)).toEqual([
      "keyword:export",
      "keyword:const",
      "type:Money",
      "fn:round",
      'string:"a\\"b"',
      "number:42",
      "comment:// done",
    ]);
    // Concatenating tokens always reproduces the source line exactly.
    expect(line!.map((t) => t.text).join("")).toBe(
      'export const x: Money = round("a\\"b", 42); // done',
    );
  });

  it("carries block comments, template literals and Python docstrings across lines", () => {
    const ts = tokenizeLines(["/* a", "b */ let y = `x", "y` + 1"], "typescript")!;
    expect(ts[0]).toEqual([{ text: "/* a", kind: "comment" }]);
    expect(ts[1]![0]).toEqual({ text: "b */", kind: "comment" });
    expect(ts[2]![0]).toEqual({ text: "y`", kind: "string" });
    expect(kinds(ts[2]!)).toContain("number:1");

    const py = tokenizeLines(
      ["def f():", '    """doc', '    more"""', "    return None  # x"],
      "python",
    )!;
    expect(kinds(py[0]!)).toEqual(["keyword:def", "fn:f"]);
    expect(py[2]).toEqual([{ text: '    more"""', kind: "string" }]);
    expect(kinds(py[3]!)).toEqual(["keyword:return", "keyword:None", "comment:# x"]);
  });

  it("treats JSON keys as types and leaves unknown languages alone", () => {
    const [line] = tokenizeLines(['  "name": "anvaya", "ok": true'], "json")!;
    expect(kinds(line!)).toEqual(['type:"name"', 'string:"anvaya"', 'type:"ok"', "keyword:true"]);
    expect(tokenizeLines(["# Title"], "markdown")).toBeNull();
    expect(tokenizeLines(["x"], null)).toBeNull();
  });

  it("does not treat digits inside identifiers as numbers", () => {
    const [line] = tokenizeLines(["const v2 = base64(x)"], "javascript")!;
    expect(kinds(line!)).toEqual(["keyword:const", "fn:base64"]);
  });
});
