import { describe, expect, it } from "vitest";

import type { CognificationCandidateBatchV1 } from "@/lib/knowledge/cognification-contract";
import {
  KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_RECORDS,
  projectKnowledgeCognitionReviewGroups,
} from "@/lib/knowledge/cognition-review-groups";
import type {
  KnowledgeCognitionRecord,
  KnowledgeCognitionStatus,
} from "@/lib/knowledge/cognification-store";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const tenantId = "tenant-cognition-review-groups";
const actorId = "actor-cognition-review-groups";

describe("knowledge cognition review-group projection", () => {
  it("groups exact and bounded paraphrase-like pending duplicates", () => {
    const current = cognitionRecord({
      seed: "current",
      status: "confirmed",
      claims: [{ statement: "The market is open today.", confidence: 9_600 }],
    });
    const pending = cognitionRecord({
      seed: "pending",
      claims: [{
        statement: "Market is definitely open today.",
        confidence: 9_100,
      }],
    });
    const exactPending = cognitionRecord({
      seed: "exact",
      claims: [{ statement: "A market is open today", confidence: 8_900 }],
    });

    const projected = projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: [current, pending, exactPending],
    });
    const duplicate = projected.find((group) => group.kind === "duplicate");

    expect(duplicate).toMatchObject({
      kind: "duplicate",
      epistemicKind: "fact",
      confidenceBasisPoints: 8_889,
    });
    expect(duplicate?.scoreBasisPoints).toBeGreaterThanOrEqual(8_500);
    expect(duplicate?.references).toHaveLength(3);
    expect(duplicate?.references.map((reference) => reference.status).sort())
      .toEqual(["confirmed", "pending_review", "pending_review"]);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(duplicate?.references)).toBe(true);

    const shuffled = projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: [exactPending, current, pending],
    });
    expect(shuffled).toEqual(projected);
  });

  it("groups likely negation conflicts without deciding which claim is true", () => {
    const current = cognitionRecord({
      seed: "current-conflict",
      status: "confirmed",
      claims: [{ statement: "The market is open today.", confidence: 9_600 }],
    });
    const pending = cognitionRecord({
      seed: "pending-conflict",
      claims: [{ statement: "The market is not open today.", confidence: 8_700 }],
    });

    const projected = projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: [current, pending],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        groupId: expect.stringMatching(/^cognition_review_group_[a-f0-9]{48}$/),
        kind: "contradiction",
        epistemicKind: "fact",
        scoreBasisPoints: 10_000,
        confidenceBasisPoints: 8_700,
        references: expect.arrayContaining([
          expect.objectContaining({
            batchId: current.candidate.batchId,
            claimCandidateId: current.candidate.claims[0].candidateId,
            claimIndex: 0,
            status: "confirmed",
            polarity: "affirmed",
          }),
          expect.objectContaining({
            batchId: pending.candidate.batchId,
            claimCandidateId: pending.candidate.claims[0].candidateId,
            claimIndex: 0,
            status: "pending_review",
            polarity: "negated",
          }),
        ]),
      }),
    ]);
    expect(current.status).toBe("confirmed");
    expect(pending.status).toBe("pending_review");
  });

  it("preserves epistemic kind and word-order distinctions", () => {
    const records = [
      cognitionRecord({
        seed: "direction-one",
        claims: [{ statement: "Alice approves Bob", confidence: 9_000 }],
      }),
      cognitionRecord({
        seed: "direction-two",
        claims: [{ statement: "Bob approves Alice", confidence: 9_000 }],
      }),
      cognitionRecord({
        seed: "prediction",
        claims: [{
          statement: "Alice approves Bob",
          epistemicKind: "prediction",
          confidence: 9_000,
        }],
      }),
    ];

    expect(projectKnowledgeCognitionReviewGroups({ tenantId, actorId, records }))
      .toEqual([]);
  });

  it("excludes dismissed candidates and groups only work involving a pending review", () => {
    const confirmedOne = cognitionRecord({
      seed: "confirmed-one",
      status: "confirmed",
      claims: [{ statement: "Markets close on holidays", confidence: 9_000 }],
    });
    const confirmedTwo = cognitionRecord({
      seed: "confirmed-two",
      status: "confirmed",
      claims: [{ statement: "Markets close on holidays", confidence: 9_000 }],
    });
    const dismissed = cognitionRecord({
      seed: "dismissed",
      status: "dismissed",
      claims: [{ statement: "Markets do not close on holidays", confidence: 9_000 }],
    });

    expect(projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: [confirmedOne, confirmedTwo, dismissed],
    })).toEqual([]);
  });

  it("fails closed for mixed actor scope and hard input bounds", () => {
    const pending = cognitionRecord({
      seed: "scope",
      claims: [{ statement: "A scoped claim", confidence: 9_000 }],
    });
    const wrongActor = cognitionRecord({
      seed: "wrong-actor",
      ownerActorId: "actor-someone-else",
      claims: [{ statement: "A scoped claim", confidence: 9_000 }],
    });

    expect(() => projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: [pending, wrongActor],
    })).toThrow("exact actor scope");
    expect(() => projectKnowledgeCognitionReviewGroups({
      tenantId,
      actorId,
      records: Array.from(
        { length: KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_RECORDS + 1 },
        () => pending,
      ),
    })).toThrow("record limit exceeded");
  });
});

function cognitionRecord(input: Readonly<{
  seed: string;
  status?: KnowledgeCognitionStatus;
  ownerActorId?: string;
  claims: readonly Readonly<{
    statement: string;
    epistemicKind?: "fact" | "procedure" | "opinion" | "prediction";
    confidence: number;
  }>[];
}>): KnowledgeCognitionRecord {
  const contractSha256 = sourceContractSha256({ seed: input.seed, type: "contract" });
  const batchDigest = sourceContractSha256({ seed: input.seed, type: "batch" });
  const candidate = {
    contractSha256,
    batchId: `cognition_batch_${batchDigest.slice(0, 48)}`,
    tenantId,
    ownerActorId: input.ownerActorId || actorId,
    documentId: `document-${input.seed}`,
    sourceItemId: `source-item-${input.seed}`,
    sourceRevisionId: `source-revision-${input.seed}`,
    claims: input.claims.map((claim, claimIndex) => ({
      candidateId: `cognition_candidate_${sourceContractSha256({
        seed: input.seed,
        claimIndex,
        statement: claim.statement,
      }).slice(0, 48)}`,
      statement: claim.statement,
      epistemicKind: claim.epistemicKind || "fact",
      confidenceBasisPoints: claim.confidence,
      evidence: [],
    })),
  } as unknown as CognificationCandidateBatchV1;
  return {
    candidate,
    status: input.status || "pending_review",
    reviewedByActorId: input.status === "confirmed" ? actorId : null,
    reviewDecision: input.status === "confirmed" ? "confirm" : null,
    reviewMetadata: {},
    reviewedAt: input.status === "confirmed" ? "2026-09-11T00:00:00.000Z" : null,
    projectedMemoryId: null,
    projectedAt: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}
