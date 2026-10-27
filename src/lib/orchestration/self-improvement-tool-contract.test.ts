import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";
import { improvementReadBatch, improvementToolInput, improvementToolSchema, type ImprovementToolBinding } from "./self-improvement-tool-contract";
const binding: ImprovementToolBinding = { projectId: "project", sessionId: `app_build_${"a".repeat(48)}`, readOnly: true,
  allowedToolIds: ["app.projects.builder.file.read"], assertCurrent: vi.fn(async () => undefined) };
const tool = { id: binding.allowedToolIds[0], riskLevel: 0, approvalRequired: false } as ToolDefinition;
const schema = { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, path: { type: "string" } }, required: ["projectId", "sessionId", "path"] };
const calls = Array.from({ length: 7 }, (_, index) => ({ callId: `read-${index}`, name: "read" }));
const options = { binding, calls, definition: () => tool, maxPerBatch: 5, remainingRounds: 16, remainingCalls: 48 };
describe("phase-bound improvement reads", () => {
  it("removes only provider coordinates and restores the exact governed input without mutating the registry", () => {
    expect(improvementToolSchema(binding, tool.id, schema)).toMatchObject({ required: ["path"], properties: { path: { type: "string" } } });
    expect(improvementToolSchema(binding, tool.id, schema).properties).not.toHaveProperty("sessionId");
    expect(schema.properties).toHaveProperty("sessionId");
    expect(improvementToolInput(binding, tool.id, { path: "src/a.ts" })).toEqual({ path: "src/a.ts", projectId: "project", sessionId: binding.sessionId });
    expect(() => improvementToolInput(binding, tool.id, { sessionId: binding.sessionId.slice(0, -4) })).toThrow("differs");
    expect(() => improvementToolInput(binding, tool.id, { projectId: "other" })).toThrow("differs");
    expect(improvementToolSchema(undefined, tool.id, schema)).toBe(schema);
    const input = { path: "src/a.ts" }; expect(improvementToolInput(undefined, tool.id, input)).toBe(input);
  });
  it("does not batch writes, approval-required tools, or ordinary requests", () => {
    expect(improvementReadBatch({ ...options, binding: undefined })).toBeUndefined();
    expect(improvementReadBatch({ ...options, binding: { ...binding, readOnly: false } })).toBeUndefined();
    expect(improvementReadBatch({ ...options, definition: () => ({ ...tool, riskLevel: 1 }) })).toBeUndefined();
    expect(improvementReadBatch({ ...options, definition: () => ({ ...tool, approvalRequired: true }) })).toBeUndefined();
    expect(improvementReadBatch({ ...options, forceApproval: true })).toBeUndefined();
  });
  it("retains two refused reads when final-answer headroom is unavailable", async () => {
    const batch = improvementReadBatch(options)!;
    expect(batch.callLimit).toBe(7); expect(batch.queued()).toHaveLength(2);
    for (let i = 0; i < 5; i++) expect(await batch.beforeCall(i, { timeReserved: false })).toBeUndefined();
    expect(await batch.beforeCall(5, { timeReserved: false, canReserveAnswer: () => false })).toBe("answer_reservation");
    expect(await batch.beforeCall(6, { timeReserved: false, canReserveAnswer: () => true })).toBe("answer_reservation");
    expect(batch.pending()).toEqual(calls.slice(5).map(call => ({ callId: call.callId, toolId: tool.id, reason: "answer_reservation" })));
  });
  it("checks the current authority and cancellation at each read, preserving call/round limits", async () => {
    const batch = improvementReadBatch({ ...options, remainingRounds: 1 })!;
    expect(batch.callLimit).toBe(5); expect(batch.pending().every(item => item.reason === "run_tool_rounds")).toBe(true);
    const limited = improvementReadBatch({ ...options, remainingCalls: 3 })!;
    expect(limited.callLimit).toBe(3); expect(limited.pending().every(item => item.reason === "run_tool_calls")).toBe(true);
    const abort = new AbortController(); abort.abort();
    await expect(batch.beforeCall(0, { timeReserved: false, abortSignal: abort.signal })).rejects.toThrow();
    const revoked = improvementReadBatch({ ...options, binding: { ...binding, assertCurrent: async () => { throw new Error("revoked"); } } })!;
    await expect(revoked.beforeCall(0, { timeReserved: false })).rejects.toThrow("revoked");
  });
});
