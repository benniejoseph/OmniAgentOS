import { describe, expect, it } from "vitest";

import {
  buildDelegationExecutionRecordV1,
  initialDelegationExecutionEventV1,
  parseDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import { buildExecutionContract } from "@/lib/delegation/test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("delegation execution lifecycle", () => {
  it("binds a queued record and content-free event to the immutable contract", () => {
    const contract = buildExecutionContract();
    const record = buildDelegationExecutionRecordV1({
      contract,
      budgetLedgerRevision: 1,
    });
    const event = initialDelegationExecutionEventV1(record);

    expect(record).toMatchObject({
      executionId: contract.delegateIdentity.runId,
      childRunId: contract.delegateIdentity.runId,
      rootExecutionId: contract.lineage.rootExecutionId,
      contractSha256: contract.contractSha256,
      contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
      runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
      budgetLedgerRevision: 1,
      state: "queued",
      lifecycleRevision: 0,
    });
    expect(event).toMatchObject({
      executionId: record.executionId,
      from: null,
      to: "queued",
      lifecycleRevision: 0,
    });
    expect(event.eventId).toBe(`delegation-execution-event:${event.eventSha256}`);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("requires proposal output before verifier-gated completion", () => {
    let record = buildDelegationExecutionRecordV1({
      contract: buildExecutionContract(),
      budgetLedgerRevision: 1,
    });
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: { to: "running" },
      at: "2026-09-22T12:00:30.000Z",
    }).record;
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: {
        to: "completed_proposed",
        result: {
          status: "completed",
          summary: "Evidence-backed research is ready for verification.",
          artifacts: [{
            artifactId: "artifact:result:one",
            artifactSha256: "f".repeat(64),
            kind: "result",
            mediaType: "application/json",
            byteCount: 128,
            evidenceIds: ["evidence:one"],
          }],
          acceptanceChecks: [{
            criterionId: "criterion:execution:one",
            passed: true,
            evidenceIds: ["evidence:one"],
            note: "The required evidence is attached.",
          }],
          evidenceIds: ["evidence:one"],
          toolExecutionIds: [],
          modelReceiptSha256s: ["1".repeat(64)],
          usageReceiptSha256s: ["2".repeat(64)],
        },
      },
      at: "2026-09-22T12:02:00.000Z",
    }).record;
    const resultSha256 = record.resultSha256!;
    const acceptanceChecksSha256 = canonicalJsonSha256(
      record.result!.acceptanceChecks,
    );
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: {
        to: "verified",
        verification: {
          verifierAgentId: record.contract.verifier.identity.logicalAgentId,
          verifierDefinitionVersion:
            record.contract.verifier.identity.definitionVersion,
          verifierPrincipalId: record.contract.verifier.identity.principalId,
          score: 0.9,
          acceptanceChecksSha256,
          evidenceIds: ["evidence:one"],
          note: "All required criteria passed.",
        },
      },
      at: "2026-09-22T12:03:00.000Z",
    }).record;

    expect(record.state).toBe("verified");
    expect(record.resultSha256).toBe(resultSha256);
    expect(record.verification).toMatchObject({
      verdict: "verified",
      resultSha256,
      score: 0.9,
    });
    expect(record.terminalAt).toBe("2026-09-22T12:03:00.000Z");
  });

  it("rejects under-threshold acceptance, tampering, and invalid transitions", () => {
    const queued = buildDelegationExecutionRecordV1({
      contract: buildExecutionContract(),
      budgetLedgerRevision: 1,
    });
    expect(() => transitionDelegationExecutionRecordV1({
      record: queued,
      transition: {
        to: "completed_proposed",
        result: {
          status: "completed",
          summary: "Invalid direct proposal.",
          artifacts: [],
          acceptanceChecks: [],
          evidenceIds: [],
          toolExecutionIds: [],
          modelReceiptSha256s: [],
          usageReceiptSha256s: [],
        },
      },
    })).toThrow(/cannot transition/);

    expect(() => parseDelegationExecutionRecordV1({
      ...queued,
      delegateAgentId: "forge",
    })).toThrow(/not bound/i);
  });
});
