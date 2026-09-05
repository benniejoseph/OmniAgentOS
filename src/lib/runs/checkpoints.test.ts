import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  RUN_CHECKPOINT_SCHEMA_VERSION,
  buildRunCheckpointV1,
  decideRunCheckpointCompatibilityV1,
  parseRunCheckpointV1,
  runCheckpointV1Schema,
  validateRunCheckpointSuccessorV1,
  type BuildRunCheckpointV1Input,
  type RunCheckpointEnginePinV1,
  type RunCheckpointStateReferenceV1,
  type RunCheckpointToolBindingV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  createExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

const RECORDED_AT = "2026-09-05T04:30:00.000Z";
const PRIVATE_PURPOSE =
  "Resume the confidential acquisition workflow without exposing its content.";

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const SCOPE = createExecutionScope({
  tenantId: "tenant_checkpoint_test",
  initiatingActorId: "actor_checkpoint_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_test",
  workspaceId: "workspace_checkpoint_test",
  projectId: "project_checkpoint_test",
  missionId: "mission_checkpoint_test",
  delegationId: null,
  correlationId: "correlation_checkpoint_test",
  causationId: "turn_checkpoint_test",
  contextGrantIds: ["context_beta", "context_alpha"],
  capabilityGrantIds: ["capability_read", "capability_execute"],
  purpose: PRIVATE_PURPOSE,
});

const PIN: RunCheckpointEnginePinV1 = {
  rolloutCapabilityId: "capability_checkpoint_resume",
  engineVersionId: "engine_checkpoint_v1",
  contractVersionId: "checkpoint_contract_v1",
  configurationSha256: digest("checkpoint-configuration"),
  runContractEnvelopeId: "run_contract_envelope_checkpoint_v1",
  runContractEnvelopeSha256: digest("checkpoint-run-contract-envelope"),
  harnessManifestId: "harness_manifest_checkpoint_v1",
  harnessManifestSha256: digest("checkpoint-harness-manifest"),
  rolloutMode: "canary",
  rolloutLifecycleStatus: "active",
  rolloutGeneration: 3,
  rolloutLifecycleRevision: 7,
};

function stateReference(
  kind: RunCheckpointStateReferenceV1["kind"],
  referenceId: string,
  seed = `${kind}:${referenceId}`,
): RunCheckpointStateReferenceV1 {
  return {
    kind,
    referenceId,
    referenceSha256: digest(seed),
    versionId: null,
  };
}

function usage(
  overrides: Partial<BuildRunCheckpointV1Input["resourceUsage"]> = {},
): BuildRunCheckpointV1Input["resourceUsage"] {
  return {
    modelCallCount: 0,
    modelInputTokenCount: 0,
    modelOutputTokenCount: 0,
    cachedInputTokenCount: 0,
    toolCallCount: 0,
    toolResultByteCount: 0,
    externalEffectCount: 0,
    boundaryExternalEffectCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function parentReference(
  seed: string,
): NonNullable<BuildRunCheckpointV1Input["parent"]> {
  return {
    checkpointId: `run_checkpoint_parent_${seed}`,
    checkpointSha256: digest(`checkpoint-parent:${seed}`),
    sequence: 0,
  };
}

function modelCheckpointInput(
  overrides: Partial<BuildRunCheckpointV1Input> = {},
): BuildRunCheckpointV1Input {
  const runId = "run_checkpoint_test";
  const boundaryId = "model_turn_checkpoint_test";
  return {
    runId,
    executionScope: SCOPE,
    boundary: {
      kind: "model",
      phase: "before",
      boundaryId,
      attempt: 1,
    },
    sequence: 0,
    parent: null,
    enginePin: PIN,
    stateReferences: [
      stateReference("model_turn", boundaryId),
      stateReference("run_record", runId),
    ],
    toolBinding: null,
    resourceUsage: usage(),
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

function mutableCheckpoint(checkpoint: RunCheckpointV1): Record<string, unknown> {
  return JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>;
}

function issuesFrom(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    return (error as ZodError).issues;
  }
  throw new Error("Expected a Zod validation failure.");
}

function expectIssue(
  action: () => unknown,
  path: (string | number)[],
  message: RegExp,
): void {
  const issues = issuesFrom(action);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path, message: expect.stringMatching(message) }),
    ]),
  );
}

function expectUnrecognizedKey(
  action: () => unknown,
  path: (string | number)[],
  key: string,
): void {
  const issues = issuesFrom(action);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unrecognized_keys",
        path,
        keys: expect.arrayContaining([key]),
      }),
    ]),
  );
}

describe("run checkpoint v1", () => {
  it("builds, parses, and deeply freezes a deterministic metadata-only checkpoint", () => {
    const first = buildRunCheckpointV1(modelCheckpointInput());
    const repeated = buildRunCheckpointV1(modelCheckpointInput());

    expect(first).toEqual(repeated);
    expect(first.schemaVersion).toBe(RUN_CHECKPOINT_SCHEMA_VERSION);
    expect(first.contractKind).toBe("run_checkpoint");
    expect(first.checkpointId).toMatch(/^run_checkpoint_[a-f0-9]{56}$/);
    expect(first.checkpointSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executionScope.tenantId).toBe(SCOPE.tenantId);
    expect(first.executionScope.initiatingActorId).toBe(
      SCOPE.initiatingActorId,
    );
    expect(first.executionScope.executingPrincipalId).toBe(
      SCOPE.executingPrincipalId,
    );
    expect(first.resourceUsage.measurementKind).toBe("cumulative");
    expect(parseRunCheckpointV1(first)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.executionScope)).toBe(true);
    expect(Object.isFrozen(first.stateReferences)).toBe(true);
    expect(Object.isFrozen(first.stateReferences[0])).toBe(true);
    expect(JSON.stringify(first)).not.toContain(PRIVATE_PURPOSE);
  });

  it("canonicalizes grant and state-reference order before deriving identity", () => {
    const input = modelCheckpointInput();
    const reverseScope: ExecutionScope = {
      ...input.executionScope,
      contextGrantIds: [...input.executionScope.contextGrantIds].reverse(),
      capabilityGrantIds: [
        ...input.executionScope.capabilityGrantIds,
      ].reverse(),
    };
    const reversed = modelCheckpointInput({
      executionScope: reverseScope,
      stateReferences: [...input.stateReferences].reverse(),
    });

    expect(buildRunCheckpointV1(reversed)).toEqual(
      buildRunCheckpointV1(input),
    );
  });

  it("rejects duplicate scope grants instead of silently changing authority", () => {
    const duplicateScope: ExecutionScope = {
      ...SCOPE,
      contextGrantIds: ["context_alpha", "context_alpha"],
    };
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        executionScope: duplicateScope,
      })),
      ["executionScope", "contextGrantIds", 1],
      /grant IDs must be unique/i,
    );
  });

  it("requires explicit initiating-actor and executing-principal attribution", () => {
    const actorlessScope: ExecutionScope = {
      ...SCOPE,
      initiatingActorId: null,
    };
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        executionScope: actorlessScope,
      })),
      ["executionScope", "initiatingActorId"],
      /requires an initiating actor/i,
    );

    const mismatchedUserScope: ExecutionScope = {
      ...SCOPE,
      executingPrincipalType: "user",
      executingPrincipalId: "actor_other_checkpoint",
    };
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        executionScope: mismatchedUserScope,
      })),
      ["executionScope", "executingPrincipalId"],
      /must execute as its initiating actor/i,
    );
  });

  it("binds a child to the immediately preceding parent hash", () => {
    const parent = buildRunCheckpointV1(modelCheckpointInput());
    const child = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: parent.boundary.boundaryId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", parent.runId),
        stateReference("model_turn", parent.boundary.boundaryId),
      ],
      sequence: 1,
      parent: {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      },
      resourceUsage: usage({
        modelCallCount: 1,
        modelInputTokenCount: 20,
        modelOutputTokenCount: 5,
        cachedInputTokenCount: 4,
        elapsedMs: 15,
      }),
    }));

    expect(child.sequence).toBe(1);
    expect(child.parent).toEqual({
      checkpointId: parent.checkpointId,
      checkpointSha256: parent.checkpointSha256,
      sequence: 0,
    });
    expect(child.resourceUsage.totalTokenCount).toBe(25);
    expect(validateRunCheckpointSuccessorV1(parent, child)).toEqual(child);
  });

  it("validates successor run, scope, pin, time, and cumulative usage", () => {
    const parent = buildRunCheckpointV1(modelCheckpointInput({
      resourceUsage: usage({
        modelCallCount: 1,
        modelInputTokenCount: 20,
        modelOutputTokenCount: 5,
        cachedInputTokenCount: 2,
        elapsedMs: 10,
      }),
    }));
    const childOverrides = {
      sequence: 1,
      parent: {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      },
      boundary: {
        kind: "model" as const,
        phase: "after" as const,
        boundaryId: parent.boundary.boundaryId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", parent.runId),
        stateReference("model_turn", parent.boundary.boundaryId),
      ],
      recordedAt: "2026-09-05T04:30:01.000Z",
      resourceUsage: usage({
        modelCallCount: 2,
        modelInputTokenCount: 30,
        modelOutputTokenCount: 7,
        cachedInputTokenCount: 3,
        elapsedMs: 20,
      }),
    };
    const child = buildRunCheckpointV1(modelCheckpointInput(childOverrides));
    expect(validateRunCheckpointSuccessorV1(parent, child)).toEqual(child);

    const wrongParentHash = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      parent: {
        ...childOverrides.parent,
        checkpointSha256: digest("wrong-parent-checkpoint"),
      },
    }));
    expect(() =>
      validateRunCheckpointSuccessorV1(parent, wrongParentHash)
    ).toThrow(/does not exactly bind its parent/i);

    const crossRun = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      runId: "run_other_checkpoint",
      stateReferences: [
        stateReference("run_record", "run_other_checkpoint"),
        stateReference("model_turn", parent.boundary.boundaryId),
      ],
    }));
    expect(() => validateRunCheckpointSuccessorV1(parent, crossRun)).toThrow(
      /different run/i,
    );

    const crossScope = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      executionScope: {
        ...SCOPE,
        executingPrincipalId: "agent_other_checkpoint",
      },
    }));
    expect(() => validateRunCheckpointSuccessorV1(parent, crossScope)).toThrow(
      /different execution scope/i,
    );

    const changedPin = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      enginePin: { ...PIN, rolloutLifecycleRevision: 8 },
    }));
    expect(() => validateRunCheckpointSuccessorV1(parent, changedPin)).toThrow(
      /changed its engine or rollout pin/i,
    );

    const earlier = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      recordedAt: "2026-09-05T04:29:59.000Z",
    }));
    expect(() => validateRunCheckpointSuccessorV1(parent, earlier)).toThrow(
      /predates its parent/i,
    );

    const lowerUsage = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      resourceUsage: usage({
        modelCallCount: 0,
        modelInputTokenCount: 20,
        modelOutputTokenCount: 5,
        cachedInputTokenCount: 2,
        elapsedMs: 10,
      }),
    }));
    expect(() => validateRunCheckpointSuccessorV1(parent, lowerUsage)).toThrow(
      /decreased cumulative modelCallCount/i,
    );

    const unattributedEffect = buildRunCheckpointV1(modelCheckpointInput({
      ...childOverrides,
      resourceUsage: usage({
        modelCallCount: 2,
        modelInputTokenCount: 30,
        modelOutputTokenCount: 7,
        cachedInputTokenCount: 3,
        externalEffectCount: 1,
        boundaryExternalEffectCount: 0,
        elapsedMs: 20,
      }),
    }));
    expect(() =>
      validateRunCheckpointSuccessorV1(parent, unattributedEffect)
    ).toThrow(/effect delta does not match its boundary receipt/i);
  });

  it("rejects successors to terminal checkpoints and receipts without cumulative effect advance", () => {
    const terminalBefore = buildRunCheckpointV1(modelCheckpointInput());
    const terminalParent = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: terminalBefore.boundary.boundaryId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("model_turn", terminalBefore.boundary.boundaryId),
      ],
      sequence: 1,
      parent: {
        checkpointId: terminalBefore.checkpointId,
        checkpointSha256: terminalBefore.checkpointSha256,
        sequence: terminalBefore.sequence,
      },
      resourceUsage: usage({ modelCallCount: 1 }),
      lifecycleState: "terminal",
      resumeDisposition: "not_resumable",
    }));
    const terminalChild = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "model",
        phase: "before",
        boundaryId: "model_turn_terminal_child",
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", terminalParent.runId),
        stateReference("model_turn", "model_turn_terminal_child"),
      ],
      sequence: 2,
      parent: {
        checkpointId: terminalParent.checkpointId,
        checkpointSha256: terminalParent.checkpointSha256,
        sequence: terminalParent.sequence,
      },
      resourceUsage: usage({ modelCallCount: 1 }),
    }));
    expect(() =>
      validateRunCheckpointSuccessorV1(terminalParent, terminalChild)
    ).toThrow(/terminal checkpoint cannot have a successor/i);

    const parentExecutionId = "tool_execution_prior_effect";
    const parentIntent = {
      referenceId: "effect_intent_prior_effect",
      referenceSha256: digest("prior-effect-intent"),
    };
    const parentReceipt = {
      referenceId: "effect_receipt_prior_effect",
      referenceSha256: digest("prior-effect-receipt"),
    };
    const priorEffectBefore = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "tool",
        phase: "before",
        boundaryId: parentExecutionId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("tool_execution", parentExecutionId),
        stateReference(
          "effect_intent",
          parentIntent.referenceId,
          "prior-effect-intent",
        ),
      ],
      toolBinding: {
        operationClass: "mutation",
        toolExecutionId: parentExecutionId,
        toolExecutionSha256: digest(
          `tool_execution:${parentExecutionId}`,
        ),
        toolId: "memory.write",
        toolContractSha256: digest("prior-effect-contract"),
        inputSha256: digest("prior-effect-input"),
        idempotencyKeySha256: digest("prior-effect-idempotency"),
        effectState: "intent_recorded",
        effectIntent: parentIntent,
        effectReceipt: null,
      },
    }));
    const parentWithPriorEffect = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "tool",
        phase: "after",
        boundaryId: parentExecutionId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("tool_execution", parentExecutionId),
        stateReference(
          "effect_intent",
          parentIntent.referenceId,
          "prior-effect-intent",
        ),
        stateReference(
          "effect_receipt",
          parentReceipt.referenceId,
          "prior-effect-receipt",
        ),
      ],
      sequence: 1,
      parent: {
        checkpointId: priorEffectBefore.checkpointId,
        checkpointSha256: priorEffectBefore.checkpointSha256,
        sequence: priorEffectBefore.sequence,
      },
      toolBinding: {
        operationClass: "mutation",
        toolExecutionId: parentExecutionId,
        toolExecutionSha256: digest(
          `tool_execution:${parentExecutionId}`,
        ),
        toolId: "memory.write",
        toolContractSha256: digest("prior-effect-contract"),
        inputSha256: digest("prior-effect-input"),
        idempotencyKeySha256: digest("prior-effect-idempotency"),
        effectState: "effect_recorded",
        effectIntent: parentIntent,
        effectReceipt: parentReceipt,
      },
      resourceUsage: usage({
        toolCallCount: 1,
        externalEffectCount: 1,
        boundaryExternalEffectCount: 1,
      }),
    }));
    const executionId = "tool_execution_unadvanced_effect";
    const intent = {
      referenceId: "effect_intent_unadvanced_effect",
      referenceSha256: digest("unadvanced-effect-intent"),
    };
    const receipt = {
      referenceId: "effect_receipt_unadvanced_effect",
      referenceSha256: digest("unadvanced-effect-receipt"),
    };
    const nextEffectBefore = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "tool",
        phase: "before",
        boundaryId: executionId,
        attempt: 1,
      },
      sequence: 2,
      parent: {
        checkpointId: parentWithPriorEffect.checkpointId,
        checkpointSha256: parentWithPriorEffect.checkpointSha256,
        sequence: parentWithPriorEffect.sequence,
      },
      stateReferences: [
        stateReference("run_record", parentWithPriorEffect.runId),
        stateReference("tool_execution", executionId),
        stateReference(
          "effect_intent",
          intent.referenceId,
          "unadvanced-effect-intent",
        ),
      ],
      toolBinding: {
        operationClass: "mutation",
        toolExecutionId: executionId,
        toolExecutionSha256: digest(`tool_execution:${executionId}`),
        toolId: "memory.write",
        toolContractSha256: digest("unadvanced-effect-contract"),
        inputSha256: digest("unadvanced-effect-input"),
        idempotencyKeySha256: digest("unadvanced-effect-idempotency"),
        effectState: "intent_recorded",
        effectIntent: intent,
        effectReceipt: null,
      },
      resourceUsage: usage({
        toolCallCount: 1,
        externalEffectCount: 1,
      }),
    }));
    const receiptWithoutAdvance = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "tool",
        phase: "after",
        boundaryId: executionId,
        attempt: 1,
      },
      sequence: 3,
      parent: {
        checkpointId: nextEffectBefore.checkpointId,
        checkpointSha256: nextEffectBefore.checkpointSha256,
        sequence: nextEffectBefore.sequence,
      },
      stateReferences: [
        stateReference("run_record", parentWithPriorEffect.runId),
        stateReference("tool_execution", executionId),
        stateReference(
          "effect_intent",
          intent.referenceId,
          "unadvanced-effect-intent",
        ),
        stateReference(
          "effect_receipt",
          receipt.referenceId,
          "unadvanced-effect-receipt",
        ),
      ],
      toolBinding: {
        operationClass: "mutation",
        toolExecutionId: executionId,
        toolExecutionSha256: digest(`tool_execution:${executionId}`),
        toolId: "memory.write",
        toolContractSha256: digest("unadvanced-effect-contract"),
        inputSha256: digest("unadvanced-effect-input"),
        idempotencyKeySha256: digest("unadvanced-effect-idempotency"),
        effectState: "effect_recorded",
        effectIntent: intent,
        effectReceipt: receipt,
      },
      resourceUsage: usage({
        toolCallCount: 2,
        externalEffectCount: 1,
        boundaryExternalEffectCount: 1,
      }),
    }));
    expect(() =>
      validateRunCheckpointSuccessorV1(
        nextEffectBefore,
        receiptWithoutAdvance,
      )
    ).toThrow(/effect delta does not match its boundary receipt/i);
  });

  it("rejects genesis parents, missing parents, and sequence gaps at their exact paths", () => {
    const parent = buildRunCheckpointV1(modelCheckpointInput());

    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        parent: {
          checkpointId: parent.checkpointId,
          checkpointSha256: parent.checkpointSha256,
          sequence: 0,
        },
      })),
      ["parent"],
      /genesis checkpoint cannot have a parent/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({ sequence: 1 })),
      ["parent"],
      /non-genesis checkpoint requires a parent/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        sequence: 2,
        parent: {
          checkpointId: parent.checkpointId,
          checkpointSha256: parent.checkpointSha256,
          sequence: 0,
        },
      })),
      ["parent", "sequence"],
      /immediately precede/i,
    );
  });

  it("rejects ID, digest, unknown-field, and noncanonical-ID wire tampering", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());

    expectIssue(
      () => parseRunCheckpointV1({
        ...checkpoint,
        checkpointId: "run_checkpoint_deadbeef",
      }),
      ["checkpointId"],
      /canonical identity/i,
    );
    expectIssue(
      () => parseRunCheckpointV1({
        ...checkpoint,
        checkpointSha256: digest("tampered-checkpoint"),
      }),
      ["checkpointSha256"],
      /digest does not match/i,
    );
    expectUnrecognizedKey(
      () => parseRunCheckpointV1({
        ...checkpoint,
        content: "raw model output",
      }),
      [],
      "content",
    );
    expect(() => parseRunCheckpointV1({
      ...checkpoint,
      runId: ` ${checkpoint.runId}`,
    })).toThrow(/canonical opaque ID/i);
  });

  it("requires boundary-specific state references and valid phase pairs", () => {
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        stateReferences: [
          stateReference("run_record", "run_checkpoint_test"),
          stateReference("model_continuation", "model_turn_checkpoint_test"),
        ],
      })),
      ["stateReferences"],
      /model_turn boundary reference is missing/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        boundary: {
          kind: "approval",
          phase: "before",
          boundaryId: "approval_checkpoint_test",
          attempt: 1,
        },
        stateReferences: [
          stateReference("run_record", "run_checkpoint_test"),
          stateReference("approval_request", "approval_checkpoint_test"),
        ],
      })),
      ["boundary", "phase"],
      /invalid for an? approval boundary/i,
    );
  });

  it("represents approval, delegation, and verifier boundary phases as references", () => {
    const cases = [
      ["approval", "after", "approval_decision"],
      ["delegation", "before", "delegation"],
      ["delegation", "waiting", "delegation"],
      ["delegation", "after", "delegation_signal"],
      ["verifier", "before", "verifier_request"],
      ["verifier", "after", "verifier_receipt"],
    ] as const;

    for (const [kind, phase, referenceKind] of cases) {
      const boundaryId = `${kind}_${phase}_checkpoint_test`;
      const checkpoint = buildRunCheckpointV1(modelCheckpointInput({
        boundary: { kind, phase, boundaryId, attempt: 1 },
        stateReferences: [
          stateReference("run_record", "run_checkpoint_test"),
          stateReference(referenceKind, boundaryId),
        ],
        lifecycleState: phase === "waiting" ? "waiting" : "active",
        resumeDisposition:
          phase === "waiting" ? "awaiting_signal" : "resumable",
      }));
      expect(checkpoint.boundary).toEqual({
        kind,
        phase,
        boundaryId,
        attempt: 1,
      });
    }
  });

  it("advances waiting approval and delegation boundaries only through their matching resolution", () => {
    const approvalId = "approval_waiting_transition";
    const executionId = "tool_execution_waiting_approval";
    const intent = {
      referenceId: "effect_intent_waiting_approval",
      referenceSha256: digest("waiting-approval-intent"),
    };
    const approvalBinding: RunCheckpointToolBindingV1 = {
      operationClass: "mutation",
      toolExecutionId: executionId,
      toolExecutionSha256: digest(`tool_execution:${executionId}`),
      toolId: "memory.write",
      toolContractSha256: digest("waiting-approval-contract"),
      inputSha256: digest("waiting-approval-input"),
      idempotencyKeySha256: digest("waiting-approval-idempotency"),
      effectState: "intent_recorded",
      effectIntent: intent,
      effectReceipt: null,
    };
    const approvalWaiting = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "approval",
        phase: "waiting",
        boundaryId: approvalId,
        attempt: 2,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("approval_request", approvalId),
        stateReference("tool_execution", executionId),
        stateReference(
          "effect_intent",
          intent.referenceId,
          "waiting-approval-intent",
        ),
      ],
      toolBinding: approvalBinding,
      lifecycleState: "waiting",
      resumeDisposition: "awaiting_signal",
    }));
    const approvalAfterInput = {
      boundary: {
        kind: "approval" as const,
        phase: "after" as const,
        boundaryId: approvalId,
        attempt: 2,
      },
      sequence: 1,
      parent: {
        checkpointId: approvalWaiting.checkpointId,
        checkpointSha256: approvalWaiting.checkpointSha256,
        sequence: approvalWaiting.sequence,
      },
      stateReferences: [
        stateReference("run_record", approvalWaiting.runId),
        stateReference("approval_decision", approvalId),
        stateReference("tool_execution", executionId),
        stateReference(
          "effect_intent",
          intent.referenceId,
          "waiting-approval-intent",
        ),
      ],
      toolBinding: approvalBinding,
      lifecycleState: "active" as const,
      resumeDisposition: "resumable" as const,
    };
    const approvalAfter = buildRunCheckpointV1(modelCheckpointInput(
      approvalAfterInput,
    ));
    expect(validateRunCheckpointSuccessorV1(
      approvalWaiting,
      approvalAfter,
    )).toEqual(approvalAfter);

    const changedAttempt = buildRunCheckpointV1(modelCheckpointInput({
      ...approvalAfterInput,
      boundary: { ...approvalAfterInput.boundary, attempt: 3 },
    }));
    expect(() => validateRunCheckpointSuccessorV1(
      approvalWaiting,
      changedAttempt,
    )).toThrow(/same kind, ID, and attempt/i);

    const changedIntent = buildRunCheckpointV1(modelCheckpointInput({
      ...approvalAfterInput,
      toolBinding: {
        ...approvalBinding,
        inputSha256: digest("changed-waiting-approval-input"),
      },
    }));
    expect(() => validateRunCheckpointSuccessorV1(
      approvalWaiting,
      changedIntent,
    )).toThrow(/changed its tool intent binding/i);

    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        ...approvalAfterInput,
        stateReferences: [
          stateReference("run_record", approvalWaiting.runId),
          stateReference("approval_request", approvalId),
          stateReference("tool_execution", executionId),
          stateReference(
            "effect_intent",
            intent.referenceId,
            "waiting-approval-intent",
          ),
        ],
      })),
      ["stateReferences"],
      /approval_decision boundary reference is missing/i,
    );

    const delegationId = "delegation_waiting_transition";
    const delegationWaiting = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "delegation",
        phase: "waiting",
        boundaryId: delegationId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("delegation", delegationId),
      ],
      lifecycleState: "waiting",
      resumeDisposition: "awaiting_signal",
    }));
    const delegationAfter = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "delegation",
        phase: "after",
        boundaryId: delegationId,
        attempt: 1,
      },
      sequence: 1,
      parent: {
        checkpointId: delegationWaiting.checkpointId,
        checkpointSha256: delegationWaiting.checkpointSha256,
        sequence: delegationWaiting.sequence,
      },
      stateReferences: [
        stateReference("run_record", delegationWaiting.runId),
        stateReference("delegation_signal", delegationId),
      ],
    }));
    expect(validateRunCheckpointSuccessorV1(
      delegationWaiting,
      delegationAfter,
    )).toEqual(delegationAfter);

    const wrongDelegation = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "delegation",
        phase: "after",
        boundaryId: "delegation_other_transition",
        attempt: 1,
      },
      sequence: 1,
      parent: {
        checkpointId: delegationWaiting.checkpointId,
        checkpointSha256: delegationWaiting.checkpointSha256,
        sequence: delegationWaiting.sequence,
      },
      stateReferences: [
        stateReference("run_record", delegationWaiting.runId),
        stateReference(
          "delegation_signal",
          "delegation_other_transition",
        ),
      ],
    }));
    expect(() => validateRunCheckpointSuccessorV1(
      delegationWaiting,
      wrongDelegation,
    )).toThrow(/same kind, ID, and attempt/i);
  });

  it("rejects raw continuation and credential fields in builder and state refs", () => {
    const input = {
      ...modelCheckpointInput(),
      continuation: { messages: ["private model context"] },
    };
    expectUnrecognizedKey(
      () => buildRunCheckpointV1(
        input as unknown as BuildRunCheckpointV1Input,
      ),
      [],
      "continuation",
    );

    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    const wire = mutableCheckpoint(checkpoint);
    const references = wire.stateReferences as Record<string, unknown>[];
    references[0] = {
      ...references[0],
      credentials: "provider-secret",
    };
    expectUnrecognizedKey(
      () => parseRunCheckpointV1(wire),
      ["stateReferences", 0],
      "credentials",
    );
  });

  it("rejects hostile accessors before invoking them", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    const hostile = mutableCheckpoint(checkpoint);
    let getterCalled = false;
    Object.defineProperty(hostile, "runId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return checkpoint.runId;
      },
    });

    expect(() => parseRunCheckpointV1(hostile)).toThrow(
      /bounded plain-data preflight/i,
    );
    expect(getterCalled).toBe(false);

    const hostileInput = { ...modelCheckpointInput() };
    Object.defineProperty(hostileInput, "runId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return checkpoint.runId;
      },
    });
    expect(() => buildRunCheckpointV1(hostileInput)).toThrow(
      /bounded plain-data preflight/i,
    );
    expect(getterCalled).toBe(false);
  });

  it("rejects cyclic, sparse, exotic, and oversized plain-data inputs", () => {
    const cyclic = mutableCheckpoint(
      buildRunCheckpointV1(modelCheckpointInput()),
    );
    cyclic.cycle = cyclic;
    expect(() => parseRunCheckpointV1(cyclic)).toThrow(
      /bounded plain-data preflight/i,
    );

    const sparse = new Array(2) as unknown[];
    sparse[1] = stateReference("run_record", "run_checkpoint_test");
    expect(() => buildRunCheckpointV1(modelCheckpointInput({
      stateReferences: sparse as RunCheckpointStateReferenceV1[],
    }))).toThrow(/bounded plain-data preflight/i);

    class ExoticCheckpoint {}
    expect(() => parseRunCheckpointV1(new ExoticCheckpoint())).toThrow(
      /bounded plain-data preflight/i,
    );

    expect(() => parseRunCheckpointV1({
      ...buildRunCheckpointV1(modelCheckpointInput()),
      privatePayload: "x".repeat(513),
    })).toThrow(/bounded plain-data preflight/i);

    expect(() => parseRunCheckpointV1({
      ...buildRunCheckpointV1(modelCheckpointInput()),
      aggregatePayload: Array.from(
        { length: 256 },
        (_, index) => `${index}:`.padEnd(300, "x"),
      ),
    })).toThrow(/bounded plain-data preflight/i);
  });

  it("accepts a mutation only after intent and idempotency are exactly bound", () => {
    const runId = "run_mutation_checkpoint";
    const executionId = "tool_execution_mutation_checkpoint";
    const intent = {
      referenceId: "effect_intent_mutation_checkpoint",
      referenceSha256: digest("mutation-intent"),
    };
    const toolBinding: RunCheckpointToolBindingV1 = {
      operationClass: "mutation",
      toolExecutionId: executionId,
      toolExecutionSha256: digest(`tool_execution:${executionId}`),
      toolId: "memory.write",
      toolContractSha256: digest("memory-write-contract"),
      inputSha256: digest("memory-write-input"),
      idempotencyKeySha256: digest("memory-write-idempotency"),
      effectState: "intent_recorded",
      effectIntent: intent,
      effectReceipt: null,
    };
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput({
      runId,
      boundary: {
        kind: "tool",
        phase: "before",
        boundaryId: executionId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", runId),
        stateReference("tool_execution", executionId),
        stateReference(
          "effect_intent",
          intent.referenceId,
          "mutation-intent",
        ),
      ],
      toolBinding,
      resourceUsage: usage(),
    }));

    expect(checkpoint.toolBinding?.effectState).toBe("intent_recorded");
    expect(checkpoint.toolBinding?.effectReceipt).toBeNull();
    expect(checkpoint.resourceUsage.boundaryExternalEffectCount).toBe(0);
  });

  it("requires an exact receipt before a mutation can claim an external effect", () => {
    const runId = "run_effect_checkpoint";
    const executionId = "tool_execution_effect_checkpoint";
    const intent = {
      referenceId: "effect_intent_effect_checkpoint",
      referenceSha256: digest("effect-intent"),
    };
    const receipt = {
      referenceId: "effect_receipt_effect_checkpoint",
      referenceSha256: digest("effect-receipt"),
    };
    const toolBinding: RunCheckpointToolBindingV1 = {
      operationClass: "mutation",
      toolExecutionId: executionId,
      toolExecutionSha256: digest(`tool_execution:${executionId}`),
      toolId: "memory.write",
      toolContractSha256: digest("effect-contract"),
      inputSha256: digest("effect-input"),
      idempotencyKeySha256: digest("effect-idempotency"),
      effectState: "effect_recorded",
      effectIntent: intent,
      effectReceipt: receipt,
    };
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput({
      runId,
      boundary: {
        kind: "tool",
        phase: "after",
        boundaryId: executionId,
        attempt: 1,
      },
      sequence: 1,
      parent: parentReference("effect_recorded"),
      stateReferences: [
        stateReference("run_record", runId),
        stateReference("tool_execution", executionId),
        stateReference("effect_intent", intent.referenceId, "effect-intent"),
        stateReference(
          "effect_receipt",
          receipt.referenceId,
          "effect-receipt",
        ),
      ],
      toolBinding,
      resourceUsage: usage({
        toolCallCount: 1,
        externalEffectCount: 1,
        boundaryExternalEffectCount: 1,
      }),
    }));

    expect(checkpoint.toolBinding?.effectReceipt).toEqual(receipt);

    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        ...modelCheckpointInput({
          runId,
          boundary: {
            kind: "tool",
            phase: "after",
            boundaryId: executionId,
            attempt: 1,
          },
          sequence: 1,
          parent: parentReference("effect_missing_receipt"),
          stateReferences: [
            stateReference("run_record", runId),
            stateReference("tool_execution", executionId),
            stateReference(
              "effect_intent",
              intent.referenceId,
              "effect-intent",
            ),
          ],
          toolBinding: { ...toolBinding, effectReceipt: null },
          resourceUsage: usage({
            toolCallCount: 1,
            externalEffectCount: 1,
            boundaryExternalEffectCount: 1,
          }),
        }),
      })),
      ["toolBinding", "effectReceipt"],
      /requires an exact receipt binding/i,
    );
  });

  it("rejects mutation checkpoints without intent, idempotency, or matching effect counts", () => {
    const runId = "run_invalid_mutation_checkpoint";
    const executionId = "tool_execution_invalid_mutation";
    const invalidBinding: RunCheckpointToolBindingV1 = {
      operationClass: "mutation",
      toolExecutionId: executionId,
      toolExecutionSha256: digest(`tool_execution:${executionId}`),
      toolId: "memory.write",
      toolContractSha256: digest("invalid-mutation-contract"),
      inputSha256: digest("invalid-mutation-input"),
      idempotencyKeySha256: null,
      effectState: "intent_recorded",
      effectIntent: null,
      effectReceipt: null,
    };
    const invalidInput = modelCheckpointInput({
      runId,
      boundary: {
        kind: "tool",
        phase: "before",
        boundaryId: executionId,
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", runId),
        stateReference("tool_execution", executionId),
      ],
      toolBinding: invalidBinding,
    });

    expectIssue(
      () => buildRunCheckpointV1(invalidInput),
      ["toolBinding", "idempotencyKeySha256"],
      /requires an idempotency-key digest/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(invalidInput),
      ["toolBinding", "effectIntent"],
      /requires a recorded effect intent/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        resourceUsage: usage({ externalEffectCount: 1 }),
      })),
      ["resourceUsage", "externalEffectCount"],
      /genesis cumulative effects must exactly match/i,
    );

    const readOnlyBinding: RunCheckpointToolBindingV1 = {
      operationClass: "read_only",
      toolExecutionId: executionId,
      toolExecutionSha256: digest(`tool_execution:${executionId}`),
      toolId: "search.read",
      toolContractSha256: digest("read-only-contract"),
      inputSha256: digest("read-only-input"),
      idempotencyKeySha256: null,
      effectState: "not_applicable",
      effectIntent: null,
      effectReceipt: null,
    };
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        runId,
        boundary: {
          kind: "tool",
          phase: "after",
          boundaryId: executionId,
          attempt: 1,
        },
        sequence: 1,
        parent: parentReference("wrong_execution_digest"),
        stateReferences: [
          stateReference("run_record", runId),
          stateReference("tool_execution", executionId),
        ],
        toolBinding: {
          ...readOnlyBinding,
          toolExecutionSha256: digest("wrong-tool-execution"),
        },
        resourceUsage: usage({ toolCallCount: 1 }),
      })),
      ["stateReferences"],
      /exact bound tool-execution reference is missing/i,
    );
    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        runId,
        boundary: {
          kind: "tool",
          phase: "after",
          boundaryId: executionId,
          attempt: 1,
        },
        sequence: 1,
        parent: parentReference("read_only_effect_count"),
        stateReferences: [
          stateReference("run_record", runId),
          stateReference("tool_execution", executionId),
        ],
        toolBinding: readOnlyBinding,
        resourceUsage: usage({
          toolCallCount: 1,
          externalEffectCount: 1,
          boundaryExternalEffectCount: 1,
        }),
      })),
      ["resourceUsage", "boundaryExternalEffectCount"],
      /exactly match its receipt state/i,
    );
  });

  it("validates resource counter relationships without trusting caller totals", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput({
      resourceUsage: usage({
        modelCallCount: 1,
        modelInputTokenCount: 30,
        modelOutputTokenCount: 10,
        cachedInputTokenCount: 5,
      }),
    }));
    expect(checkpoint.resourceUsage.totalTokenCount).toBe(40);

    expectIssue(
      () => buildRunCheckpointV1(modelCheckpointInput({
        resourceUsage: usage({
          modelInputTokenCount: 3,
          cachedInputTokenCount: 4,
        }),
      })),
      ["resourceUsage", "cachedInputTokenCount"],
      /cannot exceed model input/i,
    );

    const tampered = mutableCheckpoint(checkpoint);
    const resourceUsage = tampered.resourceUsage as Record<string, unknown>;
    resourceUsage.totalTokenCount = 41;
    expectIssue(
      () => parseRunCheckpointV1(tampered),
      ["resourceUsage", "totalTokenCount"],
      /must equal input plus output/i,
    );
  });

  it("resumes only a fully valid checkpoint with an exact supported pin", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    const decision = decideRunCheckpointCompatibilityV1({
      checkpoint,
      supportedPins: [PIN],
    });

    expect(decision.disposition).toBe("resume");
    expect(decision.reason).toBe("compatible");
    expect(decision.checkpoint).toEqual(checkpoint);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("safe-pauses unsupported schema, contract, engine, and exact pin before digest interpretation", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    const unsupportedSchema = {
      ...mutableCheckpoint(checkpoint),
      schemaVersion: 2,
      checkpointSha256: "not-a-digest",
    };
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: unsupportedSchema,
      supportedPins: [PIN],
    })).toEqual({
      disposition: "pause",
      reason: "unsupported_checkpoint_schema",
      checkpoint: null,
    });

    const unsupportedContract = mutableCheckpoint(checkpoint);
    unsupportedContract.checkpointSha256 = "not-a-digest";
    (unsupportedContract.enginePin as Record<string, unknown>).contractVersionId =
      "checkpoint_contract_v2";
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: unsupportedContract,
      supportedPins: [PIN],
    }).reason).toBe("unsupported_contract_version");

    const unsupportedEngine = mutableCheckpoint(checkpoint);
    unsupportedEngine.checkpointSha256 = "not-a-digest";
    (unsupportedEngine.enginePin as Record<string, unknown>).engineVersionId =
      "engine_checkpoint_v2";
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: unsupportedEngine,
      supportedPins: [PIN],
    }).reason).toBe("unsupported_engine_version");

    const mismatchedPin = mutableCheckpoint(checkpoint);
    mismatchedPin.checkpointSha256 = "not-a-digest";
    (mismatchedPin.enginePin as Record<string, unknown>).rolloutGeneration = 4;
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: mismatchedPin,
      supportedPins: [PIN],
    }).reason).toBe("pin_mismatch");

    const mismatchedRunContract = mutableCheckpoint(checkpoint);
    mismatchedRunContract.checkpointSha256 = "not-a-digest";
    (mismatchedRunContract.enginePin as Record<string, unknown>)
      .runContractEnvelopeSha256 = digest("different-run-contract-envelope");
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: mismatchedRunContract,
      supportedPins: [PIN],
    }).reason).toBe("pin_mismatch");
  });

  it("safe-pauses malformed supported checkpoints and non-resumable lifecycle states", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: { ...checkpoint, checkpointSha256: digest("wrong") },
      supportedPins: [PIN],
    }).reason).toBe("invalid_checkpoint");

    let supportedPinsGetterCalled = false;
    const hostileCompatibilityInput = { checkpoint } as {
      checkpoint: unknown;
      supportedPins: readonly RunCheckpointEnginePinV1[];
    };
    Object.defineProperty(hostileCompatibilityInput, "supportedPins", {
      enumerable: true,
      get() {
        supportedPinsGetterCalled = true;
        return [PIN];
      },
    });
    expect(() => decideRunCheckpointCompatibilityV1(
      hostileCompatibilityInput,
    )).toThrow(/supported checkpoint pins are invalid/i);
    expect(supportedPinsGetterCalled).toBe(false);

    let checkpointGetterCalled = false;
    const hostileCheckpointInput = { supportedPins: [PIN] } as unknown as {
      checkpoint: unknown;
      supportedPins: readonly RunCheckpointEnginePinV1[];
    };
    Object.defineProperty(hostileCheckpointInput, "checkpoint", {
      enumerable: true,
      get() {
        checkpointGetterCalled = true;
        return checkpoint;
      },
    });
    expect(decideRunCheckpointCompatibilityV1(
      hostileCheckpointInput,
    ).reason).toBe("invalid_checkpoint");
    expect(checkpointGetterCalled).toBe(false);

    const waiting = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "approval",
        phase: "waiting",
        boundaryId: "approval_request_checkpoint_test",
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference(
          "approval_request",
          "approval_request_checkpoint_test",
        ),
      ],
      lifecycleState: "waiting",
      resumeDisposition: "awaiting_signal",
    }));
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: waiting,
      supportedPins: [PIN],
    }).reason).toBe("checkpoint_awaiting_signal");

    const terminal = buildRunCheckpointV1(modelCheckpointInput({
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: "model_turn_terminal_checkpoint",
        attempt: 1,
      },
      stateReferences: [
        stateReference("run_record", "run_checkpoint_test"),
        stateReference("model_turn", "model_turn_terminal_checkpoint"),
      ],
      sequence: 1,
      parent: parentReference("terminal_compatibility"),
      resourceUsage: usage({ modelCallCount: 1 }),
      lifecycleState: "terminal",
      resumeDisposition: "not_resumable",
    }));
    expect(decideRunCheckpointCompatibilityV1({
      checkpoint: terminal,
      supportedPins: [PIN],
    }).reason).toBe("checkpoint_not_resumable");
  });

  it("exposes the same hardened behavior through the exported schema", () => {
    const checkpoint = buildRunCheckpointV1(modelCheckpointInput());
    const result = runCheckpointV1Schema.safeParse(checkpoint);
    expect(result.success).toBe(true);

    const nestedAccessor = mutableCheckpoint(checkpoint);
    let getterCalled = false;
    Object.defineProperty(nestedAccessor.enginePin as Record<string, unknown>,
      "configurationSha256", {
        enumerable: true,
        get() {
          getterCalled = true;
          return PIN.configurationSha256;
        },
      });
    const hostileResult = runCheckpointV1Schema.safeParse(nestedAccessor);
    expect(hostileResult.success).toBe(false);
    if (!hostileResult.success) {
      expect(hostileResult.error.issues).toEqual([
        expect.objectContaining({
          path: [],
          message: expect.stringMatching(/bounded plain-data preflight/i),
        }),
      ]);
    }
    expect(getterCalled).toBe(false);
  });
});
