import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { CreateMemoryInput } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  listStreamEvents: vi.fn(),
  getToolExecutionsByIds: vi.fn(),
  saveMemories: vi.fn(),
  indexMemoryGraphRecords: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
}));
vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecutionsByIds: mocks.getToolExecutionsByIds,
}));
vi.mock("@/lib/memory/store", () => ({
  saveMemories: mocks.saveMemories,
}));
vi.mock("@/lib/memory/graph", () => ({
  indexMemoryGraphRecords: mocks.indexMemoryGraphRecords,
}));

import { consolidateRunMemory } from "@/lib/memory/consolidator";

const WITHHELD_SUMMARY =
  "The run's memory decision withholds durable memory formation.";
const digest = (value: string) =>
  (value.charCodeAt(0) % 16).toString(16).repeat(64);
const runId = "run-a";
const toolExecutionId = "tool-execution-a";
const actorId = "owner@example.test";
const tenantId = "tenant-a";
const executionScope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "atlas",
  correlationId: runId,
  purpose: "agent.run",
});
const receipt = buildEffectReceiptV2({
  effectMode: "live",
  reversible: true,
  executionKind: "direct",
  executionId: toolExecutionId,
  tenantId,
  actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "atlas",
  workflowRunId: null,
  planId: null,
  planSha256: null,
  planNodeId: null,
  toolId: "calendar.create",
  toolContractSha256: digest("contract"),
  approvalState: "not_required",
  approvalBindingSha256: null,
  inputSha256: digest("input"),
  idempotencyKeySha256: digest("key"),
  targetType: "calendar_event",
  targetId: "event-a",
  providerAcknowledgement: "provider_response",
  providerAcknowledgementId: "event-a",
  providerAcknowledgementSha256: digest("provider"),
  verificationMethod: "read_after_write",
  verificationState: "verified",
  verificationReasonCode: "state_matched",
  expectedTargetStateSha256: digest("state"),
  observedTargetStateSha256: digest("state"),
});

describe("consolidating a run against its recorded memory decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getToolExecutionsByIds.mockResolvedValue([toolRecord()]);
    mocks.saveMemories.mockImplementation(
      async (inputs: CreateMemoryInput[]) => inputs.map(memoryRecord),
    );
    mocks.indexMemoryGraphRecords.mockResolvedValue(undefined);
  });

  it("forms verified-effect memory for a run that decided on durable memory", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      harnessEvent(1, "durable"),
      toolEvent(2),
    ]);

    const result = await consolidate();

    expect(mocks.listStreamEvents).toHaveBeenCalledWith(`run:${runId}`, {
      tenantId,
      limit: 2_000,
    });
    expect(mocks.getToolExecutionsByIds).toHaveBeenCalledWith(
      [toolExecutionId],
      { tenantId },
    );
    expect(mocks.saveMemories).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ skipped: false });
    expect(result.saved).toHaveLength(1);
  });

  it.each([
    ["withheld durable memory", [harnessEvent(1, "withheld"), toolEvent(2)]],
    ["recorded no decision", [toolEvent(1)]],
    ["recorded a decision without a formation value", [
      harnessEvent(1, undefined),
      toolEvent(2),
    ]],
    ["recorded an unrecognized formation value", [
      harnessEvent(1, "all"),
      toolEvent(2),
    ]],
    ["recorded a withheld decision after a durable one", [
      harnessEvent(1, "durable"),
      harnessEvent(2, "withheld"),
      toolEvent(3),
    ]],
  ])("forms no memory for a run that %s", async (_label, events) => {
    mocks.listStreamEvents.mockResolvedValue(events);

    await expect(consolidate()).resolves.toEqual({
      summary: WITHHELD_SUMMARY,
      saved: [],
      skipped: true,
    });
    expect(mocks.getToolExecutionsByIds).not.toHaveBeenCalled();
    expect(mocks.saveMemories).not.toHaveBeenCalled();
  });
});

function consolidate() {
  return consolidateRunMemory({
    tenantId,
    executionScope,
    runId,
    threadId: "thread-a",
  });
}

function harnessEvent(seq: number, memoryFormation: string | undefined) {
  return domainEvent(seq, "run.harness", {
    version: 1,
    memoryScope: "all",
    ...(memoryFormation === undefined ? {} : { memoryFormation }),
  });
}

function toolEvent(seq: number) {
  return domainEvent(seq, "run.tool", {
    executionId: toolExecutionId,
    status: "executed",
  });
}

function domainEvent(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `event-${seq}`,
    seq,
    streamId: `run:${runId}`,
    type,
    tenantId,
    actorId,
    payload,
    at: "2026-09-06T00:00:00.000Z",
  };
}

function toolRecord(): ToolExecutionRecord {
  return {
    id: toolExecutionId,
    tenantId,
    actorId,
    toolId: "calendar.create",
    toolName: "Create calendar event",
    riskLevel: 1,
    status: "executed",
    dryRun: false,
    approvalRequired: false,
    input: {},
    output: {},
    effectReceipt: receipt,
    createdAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
  };
}

function memoryRecord(input: CreateMemoryInput): MemoryRecord {
  return {
    id: input.id || "memory-a",
    type: input.type || "episode",
    title: input.title,
    content: input.content,
    tags: input.tags || [],
    scope: input.scope || "user",
    source: input.source || "effect-receipt",
    importance: input.importance ?? 0.75,
    confidence: input.confidence ?? 1,
    claimStatus: "active",
    assertedBy: "system",
    accessBinding: input.accessBinding,
    createdAt: "2026-09-06T00:00:02.000Z",
    updatedAt: "2026-09-06T00:00:02.000Z",
  };
}
