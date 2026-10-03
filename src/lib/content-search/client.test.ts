import { describe, expect, it } from "vitest";
import { contentSearchQuerySchema, contentSearchResponseSchema } from "./contracts";
import { parseContentSearchQuery, parseContentSearchResponse } from "./client";

const sample = () => ({ query: "project", generatedAt: "2026-10-04T12:00:00.123456Z", consistency: "live",
  groups: [{ provider: "work", label: "Work", coverage: "Owned active projects", status: "ready", nextCursor: null, message: null,
    items: [{ id: "project:one", title: "Project one", detail: "An owned project", updatedAt: "2026-10-04T12:00:00.123456Z", href: "/app/projects?project=one&fromSearch=1" }] }] });
function parity(value: unknown) {
  const server = contentSearchResponseSchema.safeParse(value);
  expect(parseContentSearchResponse(value)).toEqual(server.success ? server.data : undefined);
}
describe("small search display boundary", () => {
  it("matches query normalization and rejects empty/punctuation-only input", () => {
    for (const value of [" project ", "  ", "___", " a ", "a_", "汉字", "12", "a".repeat(241), "a".repeat(240), null, 2]) {
      const server = contentSearchQuerySchema.safeParse(value);
      expect(parseContentSearchQuery(value)).toBe(server.success ? server.data : undefined);
    }
  });
  it("preserves live timestamp precision and each available/unavailable group", () => {
    parity(sample());
    for (const provider of ["conversations", "work", "memory", "library"]) {
      for (const status of ["ready", "unavailable"]) parity({ ...sample(), groups: [{ ...sample().groups[0], provider, status }] });
    }
    parity({ ...sample(), query: " project ", groups: [{ ...sample().groups[0], items: [], status: "unavailable", message: "Read failed." }] });
  });
  it("rejects missing/extra fields, sparse arrays and oversized or misdirected content", () => {
    const source = sample();
    for (const key of Object.keys(source)) {
      const value = { ...source } as Record<string, unknown>;
      delete value[key]; parity(value);
    }
    parity({ ...source, extra: true }); parity({ ...source, groups: Array(1) });
    parity({ ...source, groups: Array(5).fill(source.groups[0]) });
    for (const key of Object.keys(source.groups[0])) {
      const group = { ...source.groups[0] } as Record<string, unknown>;
      delete group[key]; parity({ ...source, groups: [group] });
    }
    for (const items of [Array(1), Array(21).fill(source.groups[0].items[0])]) parity({ ...source, groups: [{ ...source.groups[0], items }] });
    for (const [key, values] of Object.entries({ id: ["", "a".repeat(361)], title: ["", "a".repeat(301)], detail: ["a".repeat(301), null], href: ["https://outside.invalid/", "javascript:alert(1)", "/app/projects", "/app/command?" + "a".repeat(1600)] })) {
      for (const value of values) parity({ ...source, groups: [{ ...source.groups[0], items: [{ ...source.groups[0].items[0], [key]: value }] }] });
    }
    expect(parseContentSearchResponse(Object.create(source))).toBeUndefined();
  });
  it("accepts exact UTC dates and rejects normalized invalid calendar values", () => {
    for (const generatedAt of ["2024-02-29T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-04T24:00:00Z", "2026-10-04T12:00:61Z", "2026-10-04T12:00:00+01:00", "2026-10-04T12:00:00.123456789Z", "0000-01-01T00:00:00Z", "invalid"]) parity({ ...sample(), generatedAt });
  });
});
