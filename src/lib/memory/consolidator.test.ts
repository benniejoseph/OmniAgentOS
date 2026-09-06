import { describe, expect, it } from "vitest";
import {
  reconcileConsolidatedMemoryClaims,
  verifiedEffectMemoryInput,
} from "@/lib/memory/consolidator";
import type { MemoryRecord } from "@/lib/memory/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const existing: MemoryRecord = {
  id: "existing",
  type: "preference",
  title: "Preferred writing style",
  content: "Use concise prose.\n\nSource run: old\nConfidence: 0.90",
  tags: [],
  scope: "workspace",
  source: "consolidator",
  importance: 0.7,
  confidence: 0.9,
  claimStatus: "active",
  assertedBy: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("memory claim reconciliation", () => {
  it("deduplicates the same claim across runs", () => {
    const result = reconcileConsolidatedMemoryClaims([{ type: "preference", title: "Preferred writing style", content: "Use concise prose.\nSource run: new\nConfidence: 0.80" }], [existing]);
    expect(result).toEqual([]);
  });

  it("quarantines contradictory agent claims as inactive candidates", () => {
    const [result] = reconcileConsolidatedMemoryClaims([{ type: "preference", title: "Preferred writing style", content: "Always use long prose.", confidence: 0.9 }], [existing]);
    expect(result).toMatchObject({ claimStatus: "candidate", contradictionOfId: "existing", confidence: 0.5 });
    expect(result.tags).toContain("needs-confirmation");
  });

  it("recognizes a renamed version of the same atomic claim", () => {
    const [result] = reconcileConsolidatedMemoryClaims([{
      type: "preference",
      title: "Writing style preference",
      content: "Use expansive prose.",
      confidence: 0.9,
    }], [existing]);
    expect(result).toMatchObject({
      claimStatus: "candidate",
      contradictionOfId: "existing",
    });
  });
});

const digest = (value: string) =>
  (value.charCodeAt(0) % 16).toString(16).repeat(64);
const toolExecutionId = "tool-execution-a";
const actorId = "owner@example.test";
const tenantId = "tenant-a";
const executionScope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "atlas",
  correlationId: "run-a",
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

function toolRecord(
  overrides: Partial<ToolExecutionRecord> = {},
): ToolExecutionRecord {
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
    input: { secret: "must-not-enter-memory" },
    output: { private: "must-not-enter-memory" },
    effectReceipt: receipt,
    createdAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
    ...overrides,
  };
}

describe("verified-effect memory formation", () => {
  it("forms a traceable metadata-only episode from a verified receipt", () => {
    const input = verifiedEffectMemoryInput({
      record: toolRecord(),
      runId: "run-a",
      threadId: "thread-a",
      executionScope,
    });
    expect(input).toMatchObject({
      type: "episode",
      claimStatus: "active",
      assertedBy: "system",
      formationOrigin: "verified_effect",
      evidenceRefs: expect.arrayContaining([
        "run:run-a",
        `tool-execution:${toolExecutionId}`,
        `effect-receipt:${receipt.effectReceiptId}`,
      ]),
    });
    expect(JSON.stringify(input)).not.toContain("must-not-enter-memory");
  });

  it.each(["failed", "blocked", "approval_required"] as const)(
    "does not turn a %s tool into a successful episode",
    (status) => {
      expect(verifiedEffectMemoryInput({
        record: toolRecord({ status }),
        runId: "run-a",
        executionScope,
      })).toBeUndefined();
    },
  );

  it("rejects dry-runs and effects attributed to another actor", () => {
    expect(verifiedEffectMemoryInput({
      record: toolRecord({ dryRun: true }),
      runId: "run-a",
      executionScope,
    })).toBeUndefined();
    expect(verifiedEffectMemoryInput({
      record: toolRecord({ actorId: "sibling@example.test" }),
      runId: "run-a",
      executionScope,
    })).toBeUndefined();
  });
});
