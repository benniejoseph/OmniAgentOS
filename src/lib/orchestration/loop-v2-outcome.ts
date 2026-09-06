import { createHash } from "node:crypto";
import { z } from "zod";

import {
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  parseLoopV2Checkpoint,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  buildHarnessManifestV1,
  buildOutcomeContractV1,
  buildRunContractEnvelopeV1,
  buildRunContractEventPayloadV1,
  buildTerminalReceiptV1,
  parseRunContractEnvelopeV1,
  runContractEventPayloadV1Schema,
  type HarnessManifestV1,
  type RequirementVerificationV1,
  type RunContractEnvelopeV1,
  type RunContractEventPayloadV1,
} from "@/lib/runs/contracts";
import {
  buildInitialShadowRunContract,
  type ShadowRunContractSnapshot,
} from "@/lib/runs/contract-runtime";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";

export const LOOP_V2_OUTCOME_CONTRACT_VERSION = 1 as const;

export type LoopV2OutcomeTaskKind =
  | "read_only_recent_runs"
  | "model_text_summary";

const readOnlyVerificationReceiptSchema = z.object({
  executionId: z.string().trim().min(1).max(240),
  operationClass: z.literal("read_only"),
  effectReceiptPresent: z.literal(false),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type LoopV2RunContractSnapshot = ShadowRunContractSnapshot & Readonly<{
  taskKind: LoopV2OutcomeTaskKind;
}>;

/**
 * Builds the declared contract. The store only admits its binding alongside a
 * root checkpoint; later checkpoints may reconstruct the same value after an
 * interruption without granting a new binding.
 */
export function buildLoopV2PreExecutionRunContract(input: {
  rootCheckpoint: LoopV2Checkpoint;
  executionScope: ExecutionScope;
  requestSha256: string;
  requestedOutcomeSha256: string;
  agentId: string;
}): LoopV2RunContractSnapshot {
  const root = parseLoopV2Checkpoint(input.rootCheckpoint);
  if (root.lifecycleState === "terminal" || root.terminalDisposition !== null) {
    throw new Error("A Loop v2 outcome contract requires a pre-terminal checkpoint.");
  }
  const taskKind = taskKindFor(root);
  const readOnly = taskKind === "read_only_recent_runs";
  const initial = buildInitialShadowRunContract({
    runId: root.runId,
    tenantId: root.tenantId,
    agentId: input.agentId,
    executionScope: input.executionScope,
    requestSha256: input.requestSha256,
    requestedOutcomeSha256: input.requestedOutcomeSha256,
    interactionMode: "orchestrate",
    executionMode: "live",
    autonomy: "governed",
    approvalPolicy: "read_only",
    budget: {
      maxModelTurns: readOnly ? 0 : 1,
      maxToolCalls: readOnly ? 1 : 0,
      maxOutputTokens: readOnly ? 0 : 256,
      maxToolResultBytes: readOnly ? 100_000 : 0,
      maxExternalEffects: 0,
      maxRetries: readOnly ? 2 : 0,
      maxReplans: readOnly ? 1 : 0,
    },
  });
  const criterionId = `${root.runId}:outcome:criterion:v1`;
  const verifierId = readOnly
    ? "agent-loop-v2-read-only-verifier:v1"
    : null;
  const outcomeContract = buildOutcomeContractV1({
    outcomeContractId: initial.envelope.outcomeContract.outcomeContractId,
    runId: root.runId,
    intentSpecId: initial.envelope.intentSpec.intentSpecId,
    contractState: "declared",
    acceptanceCriteria: [{
      criterionId,
      criterionSha256: sourceContractSha256(readOnly
        ? {
            taskKind,
            toolId: "runs.list",
            operationClass: "read_only",
            effectReceiptPresent: false,
            outputBoundToPersistedRun: true,
          }
        : {
            taskKind,
            boundedProviderOutput: true,
            semanticCorrectness: "model_assertion",
          }),
      requirementLevel: "required",
      verificationMethod: readOnly ? "deterministic" : "model_assertion",
      verifierId,
    }],
    artifactRequirements: [],
    effectRequirements: [],
  });
  const tool = readOnly ? getGovernedTool("runs.list") : undefined;
  if (readOnly && !tool) {
    throw new Error("The Loop v2 read-only tool contract is unavailable.");
  }
  const harnessManifest = rebuildHarnessManifest(
    initial.envelope.harnessManifest,
    outcomeContract,
    root,
    {
      tools: tool
        ? [{
            id: tool.id,
            pinState: "pinned" as const,
            versionId: "governed-tool-contract:v1",
            sha256: canonicalJsonSha256(tool),
          }]
        : [],
      instructionsSha256: readOnly
        ? null
        : root.enginePin.configurationSha256,
      toolboxSha256: tool ? canonicalJsonSha256([tool.id]) : canonicalJsonSha256([]),
    },
  );
  const envelope = buildRunContractEnvelopeV1({
    envelopeId: `${root.runId}:loop-v2:pre-execution:v1`,
    runId: root.runId,
    agentPrincipal: initial.envelope.agentPrincipal,
    intentSpec: initial.envelope.intentSpec,
    outcomeContract,
    contextManifests: [],
    harnessManifest,
    terminalReceipt: null,
  });
  return withTaskKind(snapshot(envelope), taskKind);
}

/** Builds an exact evaluated receipt without changing the legacy run status. */
export function buildLoopV2TerminalRunContract(input: {
  preExecution: LoopV2RunContractSnapshot;
  terminalCheckpoint: LoopV2Checkpoint;
  response?: string;
  verificationReceipt?: unknown;
}): LoopV2RunContractSnapshot {
  const preExecution = parseRunContractEnvelopeV1(input.preExecution.envelope);
  if (!preExecution) {
    throw new Error("The pre-execution run contract is missing.");
  }
  const terminal = parseLoopV2Checkpoint(input.terminalCheckpoint);
  if (
    preExecution.terminalReceipt !== null ||
    preExecution.runId !== terminal.runId ||
    terminal.toState !== "finish" ||
    terminal.lifecycleState !== "terminal" ||
    !terminal.terminalDisposition
  ) {
    throw new Error("Loop v2 terminal evidence does not match its pre-execution contract.");
  }
  assertEngineBinding(preExecution.harnessManifest, terminal);
  const criterion = preExecution.outcomeContract.acceptanceCriteria[0];
  if (!criterion || preExecution.outcomeContract.requiredCriterionCount !== 1) {
    throw new Error("Loop v2 requires one pre-bound outcome criterion.");
  }

  const response = input.response?.trim() || "";
  const responseSha256 = response ? sourceContractSha256(response) : null;
  let requirement: RequirementVerificationV1;
  let disposition: "succeeded" | "unverified" | "failed" | "canceled";
  let verificationState:
    | "verified"
    | "unverified"
    | "not_applicable";
  let reasonCode:
    | "all_requirements_verified"
    | "verification_inconclusive"
    | "execution_failed"
    | "authorized_cancellation";
  let verifierReceiptIds: string[] = [];

  if (terminal.terminalDisposition === "succeeded") {
    if (!responseSha256) {
      throw new Error("A completed Loop v2 run requires a bound response.");
    }
    if (input.preExecution.taskKind === "read_only_recent_runs") {
      const verification = readOnlyVerificationReceiptSchema.parse(
        input.verificationReceipt,
      );
      if (
        terminal.outputReceiptSha256 !==
          sourceContractSha256(verification) ||
        verification.responseSha256 !== responseSha256
      ) {
        throw new Error("The Loop v2 verification receipt does not match the terminal checkpoint.");
      }
      requirement = {
        requirementId: criterion.criterionId,
        requirementKind: "criterion",
        requirementLevel: criterion.requirementLevel,
        state: "verified",
        verificationMethod: criterion.verificationMethod,
        verifierId: criterion.verifierId,
        verificationReceiptId: terminal.checkpointId,
      };
      disposition = "succeeded";
      verificationState = "verified";
      reasonCode = "all_requirements_verified";
      verifierReceiptIds = [terminal.checkpointId];
    } else {
      requirement = unevaluatedRequirement(criterion);
      disposition = "unverified";
      verificationState = "unverified";
      reasonCode = "verification_inconclusive";
    }
  } else if (terminal.terminalDisposition === "failed") {
    requirement = {
      ...unevaluatedRequirement(criterion),
      state: "failed",
    };
    disposition = "failed";
    verificationState = "unverified";
    reasonCode = "execution_failed";
  } else {
    requirement = unevaluatedRequirement(criterion);
    disposition = "canceled";
    verificationState = "not_applicable";
    reasonCode = "authorized_cancellation";
  }

  const receipt = buildTerminalReceiptV1({
    terminalReceiptId: `${terminal.checkpointId}:terminal-receipt:v1`,
    runId: terminal.runId,
    outcomeContractId: preExecution.outcomeContract.outcomeContractId,
    source: "outcome_evaluator",
    legacyStatus: null,
    disposition,
    executionMode: "live",
    verificationState,
    reasonCode,
    requirementResults: [requirement],
    usefulWorkUnitCount: terminal.terminalDisposition === "succeeded" ? 1 : 0,
    artifactReceiptIds: [],
    effectReceiptIds: [],
    verifierReceiptIds,
    pendingApprovalIds: [],
    blockingDependencyIds: [],
    outputSha256: responseSha256,
  });
  const envelope = buildRunContractEnvelopeV1({
    envelopeId: `${terminal.runId}:loop-v2:terminal:${terminal.checkpointId}:v1`,
    runId: terminal.runId,
    agentPrincipal: preExecution.agentPrincipal,
    intentSpec: preExecution.intentSpec,
    outcomeContract: preExecution.outcomeContract,
    contextManifests: preExecution.contextManifests,
    harnessManifest: preExecution.harnessManifest,
    terminalReceipt: receipt,
  });
  return withTaskKind(snapshot(envelope), input.preExecution.taskKind);
}

export function loopV2RunContractBindingEventPayload(
  snapshotValue: LoopV2RunContractSnapshot,
) {
  const snapshot = snapshotValue;
  if (snapshot.envelope.terminalReceipt !== null) {
    throw new Error("The binding event requires a pre-execution run contract.");
  }
  return snapshot.eventPayload;
}

export function loopV2RunContractTerminalEventPayload(
  snapshotValue: LoopV2RunContractSnapshot,
) {
  const snapshot = snapshotValue;
  if (snapshot.envelope.terminalReceipt === null) {
    throw new Error("The terminal event requires an evaluated receipt.");
  }
  return snapshot.eventPayload;
}

export function loopV2RunContractComponentsMatch(
  boundValue: unknown,
  terminalValue: unknown,
) {
  const bound = parseEventPayload(boundValue);
  const terminal = parseEventPayload(terminalValue);
  const componentFields = [
    "runId",
    "agentPrincipalId",
    "agentPrincipalSha256",
    "intentSpecId",
    "intentSpecSha256",
    "outcomeContractId",
    "outcomeContractSha256",
    "harnessManifestId",
    "harnessManifestSha256",
  ] as const;
  return componentFields.every((field) => bound[field] === terminal[field]) &&
    Boolean(bound.harnessManifestSha256) &&
    bound.terminalState === "not_emitted" &&
    terminal.terminalState === "emitted";
}

function taskKindFor(checkpoint: LoopV2Checkpoint): LoopV2OutcomeTaskKind {
  if (checkpoint.enginePin.capabilityId === LOOP_V2_CAPABILITY_ID) {
    return "read_only_recent_runs";
  }
  if (checkpoint.enginePin.capabilityId === LOOP_V2_MODEL_TEXT_CAPABILITY_ID) {
    return "model_text_summary";
  }
  throw new Error("Loop v2 outcome contracts do not support this capability.");
}

function rebuildHarnessManifest(
  base: HarnessManifestV1,
  outcomeContract: ReturnType<typeof buildOutcomeContractV1>,
  checkpoint: LoopV2Checkpoint,
  pins: {
    tools: HarnessManifestV1["tools"];
    instructionsSha256: string | null;
    toolboxSha256: string;
  },
) {
  return buildHarnessManifestV1({
    harnessManifestId: `${checkpoint.runId}:loop-v2:harness:v1`,
    runId: base.runId,
    agentPrincipalId: base.agentPrincipalId,
    intentSpecId: base.intentSpecId,
    outcomeContractId: outcomeContract.outcomeContractId,
    manifestState: "partially_pinned",
    engineVersionId: checkpoint.enginePin.engineVersionId,
    agentDefinitionVersionId: base.agentDefinitionVersionId,
    promptContractVersionId: checkpoint.enginePin.contractVersionId,
    modelProvider: "unassessed",
    modelId: null,
    modelTier: "unassessed",
    modelRouteId: null,
    interactionMode: base.interactionMode,
    executionMode: "live",
    autonomy: base.autonomy,
    approvalPolicy: base.approvalPolicy,
    contextCompilerVersionId: null,
    initialContextManifestId: null,
    initialContextManifestSha256: null,
    tools: pins.tools,
    skills: [],
    policies: [{
      id: checkpoint.enginePin.capabilityId,
      pinState: "pinned",
      versionId: checkpoint.enginePin.contractVersionId,
      sha256: checkpoint.enginePin.configurationSha256,
    }],
    contextGrantIds: base.contextGrantIds,
    capabilityGrantIds: base.capabilityGrantIds,
    budgets: base.budgets,
    agentPrincipalSha256: base.agentPrincipalSha256,
    intentSpecSha256: base.intentSpecSha256,
    outcomeContractSha256: sha256Json(outcomeContract),
    instructionsSha256: pins.instructionsSha256,
    toolboxSha256: pins.toolboxSha256,
    skillSetSha256: canonicalJsonSha256([]),
    policySetSha256: canonicalJsonSha256([
      checkpoint.enginePin.configurationSha256,
    ]),
  });
}

function assertEngineBinding(
  harness: HarnessManifestV1,
  terminal: LoopV2Checkpoint,
) {
  const expectedEngine = terminal.enginePin.capabilityId === LOOP_V2_CAPABILITY_ID
    ? LOOP_V2_ENGINE_VERSION_ID
    : LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID;
  if (
    harness.engineVersionId !== expectedEngine ||
    harness.promptContractVersionId !== terminal.enginePin.contractVersionId ||
    harness.policies.length !== 1 ||
    harness.policies[0]?.id !== terminal.enginePin.capabilityId ||
    harness.policies[0]?.sha256 !== terminal.enginePin.configurationSha256
  ) {
    throw new Error("The terminal checkpoint has a different Loop v2 engine pin.");
  }
}

function unevaluatedRequirement(
  criterion: RunContractEnvelopeV1["outcomeContract"]["acceptanceCriteria"][number],
): RequirementVerificationV1 {
  return {
    requirementId: criterion.criterionId,
    requirementKind: "criterion",
    requirementLevel: criterion.requirementLevel,
    state: "unverified",
    verificationMethod: criterion.verificationMethod,
    verifierId: criterion.verifierId,
    verificationReceiptId: null,
  };
}

function parseEventPayload(value: unknown): RunContractEventPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Run contract event payload is invalid.");
  }
  const { _executionScope: _scope, ...payload } = value as Record<string, unknown>;
  void _scope;
  return runContractEventPayloadV1Schema.parse(payload);
}

function snapshot(envelope: RunContractEnvelopeV1): ShadowRunContractSnapshot {
  const envelopeSha256 = sha256Json(envelope);
  return Object.freeze({
    envelope,
    envelopeSha256,
    eventPayload: buildRunContractEventPayloadV1({
      envelope,
      envelopeSha256,
      harnessManifestSha256: sha256Json(envelope.harnessManifest),
    }),
  });
}

function withTaskKind(
  snapshotValue: ShadowRunContractSnapshot,
  taskKind: LoopV2OutcomeTaskKind,
) {
  return Object.freeze({ ...snapshotValue, taskKind });
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
