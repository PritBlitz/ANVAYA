import { describe, expect, it } from "vitest";
import { dependencyMap, parseSymbols, symbolDetail } from "./code-intel";
import { ML_PIPELINE_FILES, PAYMENTS_API_FILES } from "./repo-content";

const SHA = "a".repeat(40);

describe("fixture code intelligence (GAP-15)", () => {
  it("extracts TypeScript and Python symbols with kinds and line ranges", () => {
    const ts = parseSymbols(PAYMENTS_API_FILES, SHA);
    const refresh = ts.find((s) => s.name === "refreshSession")!;
    expect(refresh).toMatchObject({ kind: "function", path: "src/auth/refresh.ts" });
    expect(refresh.end_line).toBeGreaterThan(refresh.start_line);
    expect(ts.find((s) => s.name === "MemoryTokenStore")?.kind).toBe("class");
    expect(ts.find((s) => s.name === "TokenStore")?.kind).toBe("interface");
    expect(
      ts.some((s) => s.kind === "method" && s.qualified_name?.startsWith("MemoryTokenStore.")),
    ).toBe(true);
    // Excluded files never contribute symbols.
    expect(ts.every((s) => !s.path.startsWith("dist/"))).toBe(true);

    const py = parseSymbols(ML_PIPELINE_FILES, SHA);
    expect(py.find((s) => s.name === "Feature")?.kind).toBe("class");
    expect(py.find((s) => s.name === "train")?.kind).toBe("function");
  });

  it("resolves cross-file references in both directions", () => {
    const syms = parseSymbols(PAYMENTS_API_FILES, SHA);
    const decode = syms.find((s) => s.name === "decodeJwt")!;
    const detail = symbolDetail(PAYMENTS_API_FILES, SHA, decode.id)!;
    expect(detail.incoming.some((r) => r.source.path === "src/auth/refresh.ts")).toBe(true);

    const refresh = syms.find((s) => s.name === "refreshSession")!;
    const out = symbolDetail(PAYMENTS_API_FILES, SHA, refresh.id)!;
    expect(out.outgoing.some((r) => r.type === "calls" && r.target?.name === "isExpired")).toBe(
      true,
    );
    expect(symbolDetail(PAYMENTS_API_FILES, SHA, "nope")).toBeNull();
  });

  it("builds a file-level import graph with externals and scoping", () => {
    const map = dependencyMap(PAYMENTS_API_FILES, SHA, "");
    expect(map.edges).toContainEqual(
      expect.objectContaining({ source: "src/auth/refresh.ts", target: "src/auth/token.ts" }),
    );
    expect(map.external.map((e) => e.name)).toEqual(expect.arrayContaining(["express", "vitest"]));

    const scoped = dependencyMap(PAYMENTS_API_FILES, SHA, "src/auth");
    const lib = scoped.nodes.find((n) => n.path === "src/lib/http.ts");
    expect(lib?.in_scope).toBe(false);
    expect(scoped.nodes.find((n) => n.path === "src/auth/refresh.ts")?.in_scope).toBe(true);
    expect(scoped.nodes.some((n) => n.path.startsWith("src/payments/"))).toBe(false);

    const py = dependencyMap(ML_PIPELINE_FILES, SHA, "");
    expect(py.edges).toContainEqual(
      expect.objectContaining({ source: "pipeline/train.py", target: "pipeline/features.py" }),
    );
  });
});
