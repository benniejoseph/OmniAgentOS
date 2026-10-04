import { describe, expect, it } from "vitest";
import { promptQueueItemV1Schema } from "@/lib/command/prompt-queue-contracts";
import { PromptQueueMutationSlot, readPromptQueueItem, readPromptQueueItems, readQueueWriteResult, type QueueIntent } from "./prompt-queue-client";

const hash = "a".repeat(64);
const item = {
  schemaVersion: 1, id: "00000000-0000-4000-8000-000000000001", clientCorrelationId: "original-add",
  originSessionId: "session-a", lastModifiedSessionId: "session-a", prompt: "Review the report", promptSha256: hash,
  mode: "orchestrate", strategy: "auto", target: { threadId: null, missionId: null, projectId: null, executionTarget: "asael" }, targetSha256: hash,
  agent: { logicalAgentId: "atlas", definitionId: "agent-atlas", definitionVersion: 1, definitionVersionId: "definition-1", definitionSha256: hash, principalId: "principal", principalGeneration: 1, principalVersionId: "principal-1", principalSha256: hash },
  model: { providerId: "openai", modelId: "model", tier: "fast", assignmentId: null, assignmentRevision: null, assignmentConfigurationSha256: null, routingPolicySha256: hash },
  context: null, state: "queued", position: 1024, lifecycleRevision: 0, runId: null, resultThreadId: null,
  progressLabel: null, failureCode: null, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", dispatchedAt: null, terminalAt: null, queueGrantsAuthority: false,
};
const intent: QueueIntent = { operation: "create", id: item.clientCorrelationId, url: "/api/command/prompt-queue", method: "POST",
  body: JSON.stringify({ clientCorrelationId: item.clientCorrelationId, prompt: item.prompt, mode: item.mode, strategy: item.strategy, agentId: "atlas", target: item.target, contextReferences: [] }) };

describe("confirmed prompt queue and recovery", () => {
  it("retains the authoritative pins instead of projecting away their identity", () => {
    expect(promptQueueItemV1Schema.safeParse(item).success).toBe(true);
    expect(readPromptQueueItem(item)).toMatchObject(item);
  });
  it.each([
    { ...item, lifecycleRevision: -1 },
    { ...item, queueGrantsAuthority: true },
    { ...item, agent: { ...item.agent, principalSha256: "missing" } },
    { ...item, model: { ...item.model, assignmentId: "partial" } },
  ])("rejects malformed or incomplete pins as the domain contract does", (invalid) => {
    expect(promptQueueItemV1Schema.safeParse(invalid).success).toBe(false);
    expect(() => readPromptQueueItem(invalid)).toThrow();
  });
  it("rejects the whole read instead of silently dropping an invalid or duplicate item", () => {
    const list = { schemaVersion: 1, serverTime: item.updatedAt, items: [item, {}] };
    expect(() => readPromptQueueItems(list)).toThrow();
    expect(() => readPromptQueueItems({ ...list, items: [item, item] })).toThrow();
  });
  it("keeps exactly one frozen create through a lost response and a fresh read", () => {
    const slot = new PromptQueueMutationSlot();
    const first = slot.begin(intent);
    expect(() => slot.begin({ ...intent, id: "duplicate" })).toThrow();
    slot.uncertain();
    slot.reviewed();
    expect(slot.retry()).toBe(first);
    expect(slot.pending?.body).toBe(intent.body);
    slot.settle();
    expect(slot.pending).toBeUndefined();
  });
  it("requires a fresh review for CAS uncertainty and never replays it automatically", () => {
    const slot = new PromptQueueMutationSlot();
    slot.begin({ ...intent, operation: "delete" });
    slot.uncertain();
    expect(() => slot.retry()).toThrow();
    expect(slot.pending?.operation).toBe("delete");
    slot.reviewed();
    expect(slot.pending).toBeUndefined();
  });
  it("rejects wrong create correlation and delete identity even with successful HTTP", () => {
    expect(readQueueWriteResult(intent, { item, created: true })).toHaveLength(1);
    expect(() => readQueueWriteResult(intent, { item: { ...item, clientCorrelationId: "other" }, created: true })).toThrow();
    expect(() => readQueueWriteResult({ ...intent, operation: "delete", id: item.id }, { id: "other", deleted: true })).toThrow();
  });
});
