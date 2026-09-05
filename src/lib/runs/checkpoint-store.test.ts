import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  appendDomainEvent: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendDomainEvent: eventMocks.appendDomainEvent,
}));

import {
  recordRunCheckpointV1,
  type RunCheckpointWriterSql,
} from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  type BuildRunCheckpointV1Input,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";

const RECORDED_AT = "2026-09-05T16:45:00.000Z";

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const SCOPE = createExecutionScope({
  tenantId: "tenant_checkpoint_store",
  initiatingActorId: "actor_checkpoint_store",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_store",
  correlationId: "correlation_checkpoint_store",
  causationId: "turn_checkpoint_store",
  contextGrantIds: ["context_checkpoint_store"],
  capabilityGrantIds: ["capability_checkpoint_store"],
  purpose: "Private workflow purpose that must not enter checkpoint events.",
});

function checkpointInput(
  overrides: Partial<BuildRunCheckpointV1Input> = {},
): BuildRunCheckpointV1Input {
  return {
    runId: "run_checkpoint_store",
    executionScope: SCOPE,
    boundary: {
      kind: "model",
      phase: "before",
      boundaryId: "model_turn_checkpoint_store",
      attempt: 1,
    },
    sequence: 0,
    parent: null,
    enginePin: {
      rolloutCapabilityId: "capability_checkpoint_resume",
      engineVersionId: "engine_checkpoint_v1",
      contractVersionId: "checkpoint_contract_v1",
      configurationSha256: digest("checkpoint-config"),
      runContractEnvelopeId: "run_contract_checkpoint_store",
      runContractEnvelopeSha256: digest("run-contract"),
      harnessManifestId: "harness_checkpoint_store",
      harnessManifestSha256: digest("harness"),
      rolloutMode: "canary",
      rolloutLifecycleStatus: "active",
      rolloutGeneration: 1,
      rolloutLifecycleRevision: 1,
    },
    stateReferences: [
      {
        kind: "model_turn",
        referenceId: "model_turn_checkpoint_store",
        referenceSha256: digest("model-turn"),
        versionId: null,
      },
      {
        kind: "run_record",
        referenceId: "run_checkpoint_store",
        referenceSha256: digest("run"),
        versionId: null,
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
      elapsedMs: 0,
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

describe("run checkpoint persistence", () => {
  beforeEach(() => {
    eventMocks.appendDomainEvent.mockReset();
    eventMocks.appendDomainEvent.mockImplementation(async (input) => ({
      id: input.id,
      seq: 11,
      streamId: input.streamId,
      type: input.type,
      tenantId: input.tenantId,
      actorId: input.actorId,
      payload: input.payload,
      causationId: input.causationId,
      correlationId: input.correlationId,
      at: RECORDED_AT,
    }));
  });

  it("atomically records a checkpoint, state references, and metadata-only event", async () => {
    const checkpoint = buildRunCheckpointV1(checkpointInput());
    const { sql, calls } = fakeCheckpointSql({ checkpoint });

    const result = await recordRunCheckpointV1(
      { checkpoint, executionScope: SCOPE },
      sql,
    );

    expect(result.checkpoint).toEqual(checkpoint);
    expect(result.inserted).toBe(true);
    expect(result.resumeAuthorityGranted).toBe(false);
    expect(calls.map((call) => call.label)).toEqual([
      "checkpoint_insert",
      "reference_insert",
    ]);
    expect(eventMocks.appendDomainEvent).toHaveBeenCalledTimes(1);
    expect(eventMocks.appendDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `run-checkpoint-recorded:${checkpoint.checkpointSha256}`,
        streamId: `run:${checkpoint.runId}`,
        type: "run.checkpoint.recorded",
        tenantId: SCOPE.tenantId,
        actorId: SCOPE.initiatingActorId,
        payload: expect.objectContaining({
          checkpointId: checkpoint.checkpointId,
          executionScopeSha256:
            checkpoint.executionScope.executionScopeSha256,
          purposeSha256: checkpoint.executionScope.purposeSha256,
          stateReferenceCount: 2,
        }),
      }),
      { sql },
    );
    const eventInput = eventMocks.appendDomainEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(eventInput)).not.toContain(SCOPE.purpose);
    expect(JSON.stringify(eventInput)).not.toContain("checkpoint_json");
  });

  it("locks and validates the exact parent before recording a successor", async () => {
    const parent = buildRunCheckpointV1(checkpointInput());
    const child = buildRunCheckpointV1(checkpointInput({
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: parent.boundary.boundaryId,
        attempt: 1,
      },
      sequence: 1,
      parent: {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      },
      resourceUsage: {
        ...checkpointInput().resourceUsage,
        modelCallCount: 1,
        modelInputTokenCount: 10,
        modelOutputTokenCount: 2,
        elapsedMs: 7,
      },
    }));
    const { sql, calls } = fakeCheckpointSql({ checkpoint: child, parent });

    await recordRunCheckpointV1({ checkpoint: child, executionScope: SCOPE }, sql);

    expect(calls.map((call) => call.label)).toEqual([
      "parent",
      "checkpoint_insert",
      "reference_insert",
    ]);
    expect(calls[0]?.text).toContain("LIMIT 2 FOR SHARE");
  });

  it("accepts only an exactly matching idempotent replay", async () => {
    const checkpoint = buildRunCheckpointV1(checkpointInput());
    const { sql, calls } = fakeCheckpointSql({
      checkpoint,
      insertConflict: true,
    });

    const result = await recordRunCheckpointV1(
      { checkpoint, executionScope: SCOPE },
      sql,
    );

    expect(result.inserted).toBe(false);
    expect(calls.map((call) => call.label)).toEqual([
      "checkpoint_insert",
      "checkpoint_existing",
      "reference_existing",
    ]);
  });

  it("rejects a non-transaction client and mismatched execution scope before SQL", async () => {
    const checkpoint = buildRunCheckpointV1(checkpointInput());
    const nonTransaction = fakeCheckpointSql({
      checkpoint,
      transactionScoped: false,
    });
    await expect(recordRunCheckpointV1(
      { checkpoint, executionScope: SCOPE },
      nonTransaction.sql,
    )).rejects.toThrow(/existing database transaction/i);
    expect(nonTransaction.calls).toEqual([]);

    const mismatchedScope = createExecutionScope({
      ...SCOPE,
      initiatingActorId: "actor_checkpoint_other",
    });
    const mismatch = fakeCheckpointSql({ checkpoint });
    await expect(recordRunCheckpointV1(
      { checkpoint, executionScope: mismatchedScope },
      mismatch.sql,
    )).rejects.toThrow(/checkpoint binding changed/i);
    expect(mismatch.calls).toEqual([]);
  });

  it("fails closed on a missing parent or incomplete reference projection", async () => {
    const parent = buildRunCheckpointV1(checkpointInput());
    const child = buildRunCheckpointV1(checkpointInput({
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: parent.boundary.boundaryId,
        attempt: 1,
      },
      sequence: 1,
      parent: {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: 0,
      },
      resourceUsage: {
        ...checkpointInput().resourceUsage,
        modelCallCount: 1,
      },
    }));
    const missingParent = fakeCheckpointSql({
      checkpoint: child,
      missingParent: true,
    });
    await expect(recordRunCheckpointV1(
      { checkpoint: child, executionScope: SCOPE },
      missingParent.sql,
    )).rejects.toThrow(/exactly one run checkpoint parent/i);
    expect(eventMocks.appendDomainEvent).not.toHaveBeenCalled();

    const genesis = buildRunCheckpointV1(checkpointInput());
    const incomplete = fakeCheckpointSql({
      checkpoint: genesis,
      incompleteReferences: true,
    });
    await expect(recordRunCheckpointV1(
      { checkpoint: genesis, executionScope: SCOPE },
      incomplete.sql,
    )).rejects.toThrow(/state references are incomplete/i);
    expect(eventMocks.appendDomainEvent).not.toHaveBeenCalled();
  });
});

function fakeCheckpointSql(options: {
  checkpoint: RunCheckpointV1;
  parent?: RunCheckpointV1;
  transactionScoped?: boolean;
  insertConflict?: boolean;
  missingParent?: boolean;
  incompleteReferences?: boolean;
}) {
  const calls: Array<{ label: string; text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (
      normalized.startsWith("SELECT checkpoint_json") &&
      params[2] === options.checkpoint.parent?.checkpointId
    ) {
      calls.push({ label: "parent", text: normalized, params });
      return options.missingParent
        ? []
        : [{ checkpoint_json: options.parent }];
    }
    if (normalized.startsWith("INSERT INTO omni_run_checkpoints")) {
      calls.push({ label: "checkpoint_insert", text: normalized, params });
      return options.insertConflict
        ? []
        : [{ checkpoint_json: options.checkpoint }];
    }
    if (normalized.startsWith("INSERT INTO omni_run_checkpoint_state_references")) {
      calls.push({ label: "reference_insert", text: normalized, params });
      return referenceRows(
        options.checkpoint,
        options.incompleteReferences,
      );
    }
    if (normalized.startsWith("SELECT checkpoint_json")) {
      calls.push({ label: "checkpoint_existing", text: normalized, params });
      return [{ checkpoint_json: options.checkpoint }];
    }
    if (normalized.startsWith("SELECT ordinal")) {
      calls.push({ label: "reference_existing", text: normalized, params });
      return referenceRows(options.checkpoint, options.incompleteReferences);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const tagged = vi.fn(async () => []);
  const sql = Object.assign(tagged, {
    query,
    unsafe: vi.fn(async () => []),
    transaction: vi.fn(),
    transactionScoped: options.transactionScoped ?? true,
  }) as RunCheckpointWriterSql;
  return { sql, calls };
}

function referenceRows(
  checkpoint: RunCheckpointV1,
  incomplete = false,
) {
  const rows = checkpoint.stateReferences.map((reference, ordinal) => ({
    ordinal,
    reference_kind: reference.kind,
    reference_id: reference.referenceId,
    reference_sha256: reference.referenceSha256,
    version_id: reference.versionId,
  }));
  return incomplete ? rows.slice(1) : rows;
}
