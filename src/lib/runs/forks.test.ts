import { describe, expect, it } from "vitest";

import {
  buildCheckpointCorrectionMessages,
  buildRunForkEventPrefixV1,
  buildRunForkLineageV1,
  parseRunForkLineageV1,
  RUN_FORK_PURPOSE,
  validateRunCheckpointForkChainV1,
} from "@/lib/runs/forks";
import { buildRunCheckpointV1 } from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";

const sourceScope = createExecutionScope({
  tenantId: "tenant-1",
  initiatingActorId: "actor-1",
  executingPrincipalType: "agent",
  executingPrincipalId: "atlas",
  correlationId: "source-correlation",
  contextGrantIds: ["context-old"],
  capabilityGrantIds: ["capability-old"],
  purpose: "agent.run",
});

const checkpoint = buildRunCheckpointV1({
  runId: "run-source",
  executionScope: sourceScope,
  boundary: { kind: "model", phase: "before", boundaryId: "model-1", attempt: 1 },
  sequence: 0,
  parent: null,
  enginePin: {
    rolloutCapabilityId: "agent_run_checkpoints",
    engineVersionId: "agent_approval_continuation_v1",
    contractVersionId: "run_checkpoint_v1",
    configurationSha256: "1".repeat(64),
    runContractEnvelopeId: "envelope-1",
    runContractEnvelopeSha256: "2".repeat(64),
    harnessManifestId: "manifest-1",
    harnessManifestSha256: "3".repeat(64),
    rolloutMode: "canary",
    rolloutLifecycleStatus: "active",
    rolloutGeneration: 4,
    rolloutLifecycleRevision: 1,
  },
  stateReferences: [
    {
      kind: "run_record",
      referenceId: "run-source",
      referenceSha256: "4".repeat(64),
      versionId: "agent_run_v1",
    },
    {
      kind: "model_turn",
      referenceId: "model-1",
      referenceSha256: "5".repeat(64),
      versionId: "model_turn_v1",
    },
  ],
  toolBinding: null,
  resourceUsage: {
    modelCallCount: 0,
    modelInputTokenCount: 0,
    modelOutputTokenCount: 0,
    cachedInputTokenCount: 0,
    toolCallCount: 0,
    toolResultByteCount: 0,
    externalEffectCount: 0,
    boundaryExternalEffectCount: 0,
    elapsedMs: 10,
  },
  lifecycleState: "active",
  resumeDisposition: "resumable",
  recordedAt: "2026-09-06T10:00:00.000Z",
});

function freshScope() {
  return createExecutionScope({
    tenantId: "tenant-1",
    initiatingActorId: "actor-1",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "fork-request-1",
    causationId: checkpoint.checkpointId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: RUN_FORK_PURPOSE,
  });
}

describe("run checkpoint forks", () => {
  it("builds deterministic metadata-only lineage with fresh empty grants", () => {
    const first = buildRunForkLineageV1({
      checkpoint,
      executionScope: freshScope(),
      correction: "Use the verified source and keep the answer concise.",
      idempotencyKey: "request-1",
      eventPrefix: { count: 4, lastSeq: 18, sha256: "a".repeat(64) },
      createdAt: "2026-09-06T10:01:00.000Z",
    });
    const second = buildRunForkLineageV1({
      checkpoint,
      executionScope: freshScope(),
      correction: "Use the verified source and keep the answer concise.",
      idempotencyKey: "request-1",
      eventPrefix: { count: 4, lastSeq: 18, sha256: "a".repeat(64) },
      createdAt: "2026-09-06T10:01:00.000Z",
    });

    expect(second).toEqual(first);
    expect(first.target.approvalInheritance).toBe("none");
    expect(first.target.continuationInheritance).toBe("none");
    expect(first.target.contextGrantIdsSha256).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(JSON.stringify(first)).not.toContain("verified source");
    expect(Object.isFrozen(first.source)).toBe(true);
  });

  it("rejects lineage whose deterministic target identity was modified", () => {
    const lineage = buildRunForkLineageV1({
      checkpoint,
      executionScope: freshScope(),
      correction: "Correct this step.",
      idempotencyKey: "request-2",
      eventPrefix: { count: 1, lastSeq: 2, sha256: "b".repeat(64) },
      createdAt: "2026-09-06T10:02:00.000Z",
    });
    expect(() => parseRunForkLineageV1({
      ...lineage,
      target: { ...lineage.target, runId: "another-run" },
    })).toThrow(/target identity/i);
  });

  it("creates a bounded correction turn without copying stale authority", () => {
    const messages = buildCheckpointCorrectionMessages({
      sourceMessages: [{ role: "user", content: "Original task" }],
      checkpoint,
      correction: "Take the safer interpretation.",
      maxMessages: 40,
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Take the safer interpretation.");
    expect(messages[1].content).toContain("Prior approvals and continuation authority do not carry");
  });

  it("validates the exact checkpoint root and event prefix", () => {
    expect(validateRunCheckpointForkChainV1([checkpoint], checkpoint.checkpointId))
      .toEqual(checkpoint);
    const prefix = buildRunForkEventPrefixV1([
      {
        id: "event-1",
        seq: 4,
        type: "run.scope_bound",
        payload: { scopeVersion: 1 },
        at: "2026-09-06T10:00:00.000Z",
      },
      {
        id: "event-2",
        seq: 8,
        type: "run.checkpoint.recorded",
        payload: {
          checkpointId: checkpoint.checkpointId,
          checkpointSha256: checkpoint.checkpointSha256,
        },
        at: "2026-09-06T10:00:01.000Z",
      },
    ], checkpoint);

    expect(prefix).toMatchObject({ count: 2, lastSeq: 8 });
    expect(prefix.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildRunForkEventPrefixV1([
      {
        id: "event-2",
        seq: 8,
        type: "run.checkpoint.recorded",
        payload: {
          checkpointId: checkpoint.checkpointId,
          checkpointSha256: "0".repeat(64),
        },
        at: "2026-09-06T10:00:01.000Z",
      },
    ], checkpoint)).toThrow(/exact checkpoint event/i);
  });
});
