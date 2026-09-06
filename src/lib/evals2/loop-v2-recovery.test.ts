import { afterEach, describe, expect, it, vi } from "vitest";

import recoverySuite from "../../../evals/p61/interruption-recovery.v1.json";
import {
  loopV2RecoveryEvaluationSuiteSchema,
  runLoopV2RecoveryEvaluation,
} from "@/lib/evals2/loop-v2-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Loop v2 recovery production-like evaluation", () => {
  it("meets recovery, trace, fencing, duplicate-effect, and truthfulness gates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runLoopV2RecoveryEvaluation({
      suite: recoverySuite,
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p61-evaluation-a",
    });

    expect(result.report).toMatchObject({
      schemaVersion: 1,
      suiteId: "p6.1-loop-v2-interruption-recovery-v1",
      suiteSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      caseCount: 15,
      passedCaseCount: 15,
      recoveryEligible: 7,
      recovered: 7,
      recoveryRateBasisPoints: 10_000,
      duplicateEffectCount: 0,
      falseSuccessCount: 0,
      unfencedWriteCount: 0,
      genericFailureMutationCount: 0,
      traceIncompleteCount: 0,
      missingFirstProgressCount: 0,
      failedCaseIds: [],
      passed: true,
    });
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: "read.retry.twice",
        observedOutcome: "resumed",
        toolAttempts: 3,
        uniqueLogicalActionKeys: 1,
      }),
      expect.objectContaining({
        caseId: "read.stale-fence",
        observedOutcome: "deferred",
        genericFailureMutationCount: 0,
      }),
      expect.objectContaining({
        caseId: "read.verification.effect-receipt",
        observedOutcome: "failed_closed",
        falseSuccessCount: 0,
      }),
      expect.objectContaining({
        caseId: "model.interrupt.act",
        observedOutcome: "failed_closed",
        toolAttempts: 0,
      }),
    ]));
  });

  it("rejects a weakened suite that omits a required fault class", () => {
    const weakened = {
      ...recoverySuite,
      cases: recoverySuite.cases.filter((testCase) =>
        testCase.fault !== "inactive_wait"
      ),
    };
    expect(() => loopV2RecoveryEvaluationSuiteSchema.parse(weakened)).toThrow(
      "inactive_wait fault coverage",
    );
  });
});
