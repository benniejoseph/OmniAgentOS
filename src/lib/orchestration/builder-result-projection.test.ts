import { describe, expect, it } from "vitest";
import { projectBuilderExecutionPayload } from "./builder-result-projection";
import { serializeProjectedToolResult } from "./tool-result-projection";
import { redactSensitive } from "@/lib/security/context";

const file = (content: string) => ({ path: "src/feature.ts", sha256: "a".repeat(64), size: Buffer.byteLength(content), content,
  lineRange: { startLine: 10, endLine: 9 + content.split("\n").length, totalLines: 1_000, truncated: true } });
const payload = (value: unknown) => ({ executionId: "read", status: "executed", dryRun: false, result: { file: value, serviceReceipt: { receiptSha256: "b".repeat(64) } } });
function delivered(value: Record<string, unknown>, tool = "app.projects.builder.file.read") {
  const projected = projectBuilderExecutionPayload(tool, value, 8_000);
  return { projected, envelope: JSON.parse(serializeProjectedToolResult(projected || value, 8_000)) };
}
describe("bounded Builder model delivery", () => {
  it("delivers whole lines with exact continuation after JSON escaping and leaves the durable result unchanged", () => {
    const content = Array.from({ length: 311 }, (_, i) => `line ${i}: ${'quoted "value" \\ '.repeat(5)}`).join("\n");
    const original = payload(file(content)), snapshot = JSON.stringify(original);
    const { envelope } = delivered(original), shown = envelope.data.result.file;
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8_000);
    expect(envelope.coverage).toBeUndefined();
    expect(shown.content.split("\n")).toEqual(content.split("\n").slice(0, shown.lineRange.endLine - 9));
    expect(shown.lineRange).toMatchObject({ startLine: 10, truncated: true });
    expect(shown.projection.nextRead).toEqual({ path: "src/feature.ts", startLine: shown.lineRange.endLine + 1, lineCount: 200 });
    expect(shown.sha256).toBe("a".repeat(64));
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it("preserves a complete small source result and ordinary non-Builder results", () => {
    const small = payload(file("one\ntwo"));
    expect(delivered(small).projected).toBe(small);
    expect(projectBuilderExecutionPayload("ordinary.read", small, 8_000)).toBeUndefined();
  });
  it("refuses false line coverage after real multiline-secret redaction even below the size limit", () => {
    const raw = payload(file("before\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nafter"));
    const redacted = redactSensitive(raw) as Record<string, unknown>;
    const shown = delivered(redacted).envelope.data.result.file;
    expect(shown.content).toBe("");
    expect(shown.lineRange.endLine).toBeNull();
    expect(shown.projection.nextRead).toBeUndefined();
    expect(shown.projection.limitation).toContain("transformation");
  });
  it("does not advertise a partial character-cutoff line or loop over an oversized first line", () => {
    const partial = { ...file("whole\npartial"), lineRange: { startLine: 1, endLine: 2, totalLines: 3, truncated: true, characterLimitReached: true } };
    const shown = delivered(payload(partial)).envelope.data.result.file;
    expect(shown.content).toBe("whole");
    expect(shown.lineRange.endLine).toBe(1);
    expect(shown.projection.nextRead.startLine).toBe(2);
    const huge = delivered(payload(file("x".repeat(30_000)))).envelope.data.result.file;
    expect(huge.content).toBe("");
    expect(huge.lineRange.endLine).toBeNull();
    expect(huge.projection.nextRead).toBeUndefined();
  });
  it("bounds documentation metadata when redaction invalidates its range", () => {
    const original = { ...payload(null), result: { documentation: { label: "x".repeat(40_000), file: { ...file("one"), lineRange: { startLine: 1, endLine: 5, totalLines: 5 } } } } };
    const { envelope } = delivered(original, "app.projects.builder.framework-doc.read");
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8_000);
    expect(envelope.coverage).toBeUndefined();
    expect(envelope.data.result.documentation.file.lineRange.endLine).toBeNull();
  });
});
