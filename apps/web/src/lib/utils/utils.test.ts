import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompact,
  formatCost,
  formatDateTime,
  formatDuration,
  formatRelative,
  lineRange,
  pluralize,
  shortSha,
  slugify,
} from "./format";
import { safeNextPath } from "./url";

describe("format", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");

  it("formats relative times", () => {
    expect(formatRelative("2026-11-02T11:59:50Z", now)).toBe("just now");
    expect(formatRelative("2026-11-02T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelative("2026-11-01T12:00:00Z", now)).toBe("yesterday");
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative("not a date", now)).toBe("—");
  });

  it("formats absolute times in UTC (stable across server and browser)", () => {
    expect(formatDateTime("2026-11-02T10:05:00Z")).toBe("2026-11-02 10:05 UTC");
  });

  it("formats durations", () => {
    expect(formatDuration(950)).toBe("950ms");
    expect(formatDuration(6120)).toBe("6.1s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(null)).toBe("—");
  });

  it("formats cost from micro-units", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(4_000)).toBe("< $0.01");
    expect(formatCost(1_250_000)).toBe("$1.25");
    expect(formatCost(null)).toBe("—");
  });

  it("formats numbers, bytes, shas, ranges", () => {
    expect(formatCompact(1234)).toBe("1.2K");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(shortSha("9f3c2a17e4b5")).toBe("9f3c2a1");
    expect(lineRange(24, 51)).toBe("L24–51");
    expect(lineRange(7, 7)).toBe("L7");
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(3, "file")).toBe("3 files");
  });

  it("slugifies workspace names", () => {
    expect(slugify("Acme Engineering!")).toBe("acme-engineering");
    expect(slugify("  Café — Platform  ")).toBe("cafe-platform");
    expect(slugify("x".repeat(60)).length).toBeLessThanOrEqual(40);
  });
});

describe("safeNextPath", () => {
  it("allows same-origin paths", () => {
    expect(safeNextPath("/w/acme/runs")).toBe("/w/acme/runs");
    expect(safeNextPath(encodeURIComponent("/w/acme?x=1"))).toBe("/w/acme?x=1");
  });

  it.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "/javascript:alert(1)",
    "/login?next=/x",
    "%E0%A4%A",
  ])("rejects %s", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("falls back when empty", () => {
    expect(safeNextPath(null, "/home")).toBe("/home");
  });
});
