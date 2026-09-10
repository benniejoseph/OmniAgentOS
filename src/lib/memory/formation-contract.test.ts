import { describe, expect, it } from "vitest";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { buildMemoryFormationEvent } from "@/lib/memory/formation-contract";
import type { MemoryRecord } from "@/lib/memory/types";
import { createExecutionScope } from "@/lib/security/execution-scope";

const formedAt = "2026-09-06T00:00:00.000Z";
const executionScope = createExecutionScope({
  tenantId: "tenant-a",
  initiatingActorId: "actor:owner",
  executingPrincipalType: "user",
  executingPrincipalId: "actor:owner",
  correlationId: "formation-test",
  purpose: "memory.formation.test",
});

function memory(
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id: "memory-a",
    tenantId: "tenant-a",
    type: "fact",
    title: "Remembered assertion",
    content: "The launch window is Tuesday.",
    tags: [],
    scope: "user",
    source: "user-assertion",
    importance: 0.8,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefs: ["thread:thread-a", "turn:turn-a"],
    createdAt: formedAt,
    updatedAt: formedAt,
    accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId: "actor:owner",
      originPurpose: "memory.user_assertion",
      accessBoundAt: formedAt,
    }),
    ...overrides,
  };
}

describe("memory formation receipt", () => {
  it("records a metadata-only receipt for a private user assertion", () => {
    const event = buildMemoryFormationEvent({
      record: memory(),
      origin: "user_assertion",
      executionScope,
    });

    expect(event).toMatchObject({
      streamId: "memory:memory-a",
      type: "memory.formation.recorded",
      payload: {
        origin: "user_assertion",
        claimStatus: "active",
        assertedBy: "user",
        evidenceRefs: ["thread:thread-a", "turn:turn-a"],
      },
    });
    expect(JSON.stringify(event.payload)).not.toContain(
      "The launch window is Tuesday",
    );
  });

  it("rejects active assistant prose but accepts an inference candidate", () => {
    const assistant = memory({
      type: "fact",
      source: "assistant-inference",
      assertedBy: "agent",
      accessBinding: undefined,
      evidenceRefs: ["run:run-a"],
    });
    expect(() => buildMemoryFormationEvent({
      record: assistant,
      origin: "assistant_inference",
      executionScope,
    })).toThrow(/inference candidate/i);

    expect(buildMemoryFormationEvent({
      record: { ...assistant, claimStatus: "candidate" },
      origin: "assistant_inference",
      executionScope,
    }).payload.claimStatus).toBe("candidate");
  });

  it("requires complete lineage for source and verified-effect memories", () => {
    expect(() => buildMemoryFormationEvent({
      record: memory({
        type: "knowledge",
        assertedBy: "import",
        accessBinding: undefined,
        evidenceRefs: ["knowledge:document-a"],
      }),
      origin: "source_observation",
      executionScope,
    })).toThrow(/canonical knowledge and evidence/i);

    expect(buildMemoryFormationEvent({
      record: memory({
        type: "episode",
        assertedBy: "system",
        accessBinding: undefined,
        evidenceRefs: [
          "run:run-a",
          "tool-execution:tool-a",
          "effect-receipt:receipt-a",
        ],
      }),
      origin: "verified_effect",
      executionScope,
    }).payload.origin).toBe("verified_effect");
  });

  it("forms source cognition only after user review with exact evidence lineage", () => {
    const reviewed = memory({
      type: "knowledge",
      formationReason: "source_cognition",
      source: "cognify-reviewed:cognition-batch-a",
      evidenceRefs: [
        "knowledge:document-a",
        "evidence:evidence-a",
        "cognition-review:cognition-batch-a",
      ],
    });

    expect(buildMemoryFormationEvent({
      record: reviewed,
      origin: "reviewed_source_cognition",
      executionScope,
    }).payload).toMatchObject({
      origin: "reviewed_source_cognition",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: [
        "knowledge:document-a",
        "evidence:evidence-a",
        "cognition-review:cognition-batch-a",
      ],
    });

    for (const record of [
      { ...reviewed, claimStatus: "candidate" as const },
      { ...reviewed, assertedBy: "agent" as const },
      { ...reviewed, source: "cognify-proposed:cognition-batch-a" },
      {
        ...reviewed,
        evidenceRefs: reviewed.evidenceRefs?.filter((reference) =>
          !reference.startsWith("knowledge:")
        ),
      },
      {
        ...reviewed,
        evidenceRefs: reviewed.evidenceRefs?.filter((reference) =>
          !reference.startsWith("evidence:")
        ),
      },
      {
        ...reviewed,
        evidenceRefs: reviewed.evidenceRefs?.filter((reference) =>
          !reference.startsWith("cognition-review:")
        ),
      },
    ]) {
      expect(() => buildMemoryFormationEvent({
        record,
        origin: "reviewed_source_cognition",
        executionScope,
      })).toThrow(/user-confirmed memory with exact knowledge and evidence lineage/i);
    }
  });
});
