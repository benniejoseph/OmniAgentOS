import { describe, expect, it } from "vitest";

import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
  LOOP_V2_CONTEXT_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
} from "@/lib/orchestration/loop-v2";
import {
  buildLoopV2ContextManifest,
  buildLoopV2PreExecutionRunContract,
  buildLoopV2TerminalRunContract,
  loopV2ContextManifestSha256,
  loopV2RunContractComponentsMatch,
} from "@/lib/orchestration/loop-v2-outcome";
import { buildLoopV2ContextBindingV1 } from "@/lib/orchestration/loop-v2-context-contract";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const NOW = "2026-09-06T02:00:00.000Z";
const RESPONSE = "Here are your most recent agent runs.";

describe("Loop v2 exact outcome contracts", () => {
  it("pre-binds and exactly verifies the deterministic read-only outcome", () => {
    const root = initial("read");
    const preExecution = prebind(root, "read");
    const verificationReceipt = {
      executionId: "tool-execution-1",
      operationClass: "read_only" as const,
      effectReceiptPresent: false as const,
      responseSha256: sourceContractSha256(RESPONSE),
    };
    const terminal = finish(root, "succeeded", verificationReceipt);
    const completed = buildLoopV2TerminalRunContract({
      preExecution,
      terminalCheckpoint: terminal,
      response: RESPONSE,
      verificationReceipt,
    });

    expect(preExecution.envelope.outcomeContract.contractState).toBe(
      "declared",
    );
    expect(preExecution.envelope.outcomeContract.requiredCriterionCount).toBe(1);
    expect(preExecution.eventPayload.harnessManifestSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(completed.envelope.terminalReceipt).toMatchObject({
      source: "outcome_evaluator",
      disposition: "succeeded",
      verificationState: "verified",
      executionMode: "live",
      verifiedRequirementCount: 1,
      unverifiedRequirementCount: 0,
    });
    expect(loopV2RunContractComponentsMatch(
      preExecution.eventPayload,
      completed.eventPayload,
    )).toBe(true);
  });

  it("rejects a response or verification receipt detached from the checkpoint", () => {
    const root = initial("read");
    const preExecution = prebind(root, "read");
    const verificationReceipt = {
      executionId: "tool-execution-1",
      operationClass: "read_only" as const,
      effectReceiptPresent: false as const,
      responseSha256: sourceContractSha256(RESPONSE),
    };
    const terminal = finish(root, "succeeded", verificationReceipt);

    expect(() => buildLoopV2TerminalRunContract({
      preExecution,
      terminalCheckpoint: terminal,
      response: "Different response",
      verificationReceipt,
    })).toThrow(/verification receipt/i);
    expect(() => buildLoopV2TerminalRunContract({
      preExecution,
      terminalCheckpoint: terminal,
      response: RESPONSE,
      verificationReceipt: {
        ...verificationReceipt,
        executionId: "tool-execution-other",
      },
    })).toThrow(/verification receipt/i);
  });

  it("keeps a structurally valid model completion semantically unverified", () => {
    const root = initial("model");
    const preExecution = prebind(root, "model");
    const terminal = finish(root, "succeeded", {
      responseSha256: sourceContractSha256(RESPONSE),
      provider: "openai",
    });
    const completed = buildLoopV2TerminalRunContract({
      preExecution,
      terminalCheckpoint: terminal,
      response: RESPONSE,
    });

    expect(completed.envelope.outcomeContract.acceptanceCriteria[0])
      .toMatchObject({ verificationMethod: "model_assertion" });
    expect(completed.envelope.terminalReceipt).toMatchObject({
      disposition: "unverified",
      verificationState: "unverified",
      reasonCode: "verification_inconclusive",
      unverifiedRequirementCount: 1,
    });
  });

  it("pre-binds the authorized context manifest for the context-text engine", () => {
    const contextManifest = buildLoopV2ContextManifest({
      runId: "run-a",
      querySha256: sourceContractSha256("query"),
      contextScope: "session",
      selectedContext: [],
      userInclusionIds: [],
      userExclusionIds: [],
      compiledContextSha256: sourceContractSha256("conversation"),
      contextTokenCount: 32,
      providerId: "openai",
      compilerVersionId: "context-compiler:v1",
    });
    const contextBinding = buildLoopV2ContextBindingV1({
      tenantId: "tenant-a",
      runId: "run-a",
      ownerActorId: "actor-a",
      agentPrincipalId: "atlas",
      contextScope: "session",
      authoritySha256: sourceContractSha256("session"),
      executionScope: scope("context"),
      querySha256: sourceContractSha256("query"),
      conversationSha256: sourceContractSha256("conversation"),
      contextManifestSha256: loopV2ContextManifestSha256(contextManifest),
      compiledContextSha256: sourceContractSha256("conversation"),
      selectedEvidenceIds: [],
      boundAt: NOW,
    });
    const root = initial("context", contextBinding.bindingSha256);
    const preExecution = buildLoopV2PreExecutionRunContract({
      rootCheckpoint: root,
      executionScope: scope("context"),
      requestSha256: sourceContractSha256("private request"),
      requestedOutcomeSha256: sourceContractSha256("private outcome"),
      agentId: "atlas",
      contextManifest,
      contextBinding,
    });

    expect(preExecution).toMatchObject({
      taskKind: "model_context_summary",
      envelope: {
        contextManifests: [expect.objectContaining({
          contextManifestId: contextManifest.contextManifestId,
          providerDisclosureBoundary: "authorized_content",
        })],
        harnessManifest: expect.objectContaining({
          engineVersionId: LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
          initialContextManifestId: contextManifest.contextManifestId,
        }),
      },
    });
  });

  it.each(["failed", "canceled"] as const)(
    "cannot upgrade a %s terminal checkpoint to success",
    (terminalDisposition) => {
      const root = initial("read");
      const preExecution = prebind(root, "read");
      const terminal = finish(root, terminalDisposition, {
        reason: terminalDisposition,
      });
      const completed = buildLoopV2TerminalRunContract({
        preExecution,
        terminalCheckpoint: terminal,
      });

      expect(completed.envelope.terminalReceipt?.disposition).toBe(
        terminalDisposition,
      );
      expect(completed.envelope.terminalReceipt?.verificationState).not.toBe(
        "verified",
      );
    },
  );

  it("detects a changed harness component between binding and terminal events", () => {
    const root = initial("read");
    const preExecution = prebind(root, "read");
    const verificationReceipt = {
      executionId: "tool-execution-1",
      operationClass: "read_only" as const,
      effectReceiptPresent: false as const,
      responseSha256: sourceContractSha256(RESPONSE),
    };
    const completed = buildLoopV2TerminalRunContract({
      preExecution,
      terminalCheckpoint: finish(root, "succeeded", verificationReceipt),
      response: RESPONSE,
      verificationReceipt,
    });

    expect(loopV2RunContractComponentsMatch(
      preExecution.eventPayload,
      {
        ...completed.eventPayload,
        harnessManifestSha256: "0".repeat(64),
      },
    )).toBe(false);
  });
});

function initial(
  kind: "read" | "model" | "context",
  contextBindingSha256 = sourceContractSha256("context-binding"),
) {
  return createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-a",
    ownerActorId: "actor-a",
    executionScope: scope(kind),
    enginePin: buildLoopV2EnginePin(rollout(kind)),
    ...(kind === "context"
      ? {
          contextScope: "session" as const,
          contextBindingSha256,
        }
      : {}),
    transitionedAt: NOW,
  });
}

function prebind(
  root: ReturnType<typeof initial>,
  kind: "read" | "model" | "context",
) {
  return buildLoopV2PreExecutionRunContract({
    rootCheckpoint: root,
    executionScope: scope(kind),
    requestSha256: sourceContractSha256("private request"),
    requestedOutcomeSha256: sourceContractSha256("private outcome"),
    agentId: "atlas",
  });
}

function finish(
  root: ReturnType<typeof initial>,
  terminalDisposition: "succeeded" | "failed" | "canceled",
  receipt: unknown,
) {
  if (terminalDisposition === "canceled") {
    return advanceLoopV2Checkpoint({
      current: root,
      executionScope: scopeFor(root),
      trigger: "canceled",
      outputReceiptSha256: sourceContractSha256(receipt),
      transitionedAt: "2026-09-06T02:01:00.000Z",
    });
  }
  if (terminalDisposition === "failed") {
    return advanceLoopV2Checkpoint({
      current: root,
      executionScope: scopeFor(root),
      trigger: "budget_exhausted",
      outputReceiptSha256: sourceContractSha256(receipt),
      transitionedAt: "2026-09-06T02:01:00.000Z",
    });
  }
  let current = advanceLoopV2Checkpoint({
    current: root,
    executionScope: scopeFor(root),
    trigger: "plan_bound",
    outputReceiptSha256: sourceContractSha256("plan"),
    transitionedAt: "2026-09-06T02:01:00.000Z",
  });
  current = advanceLoopV2Checkpoint({
    current,
    executionScope: scopeFor(root),
    trigger: "action_started",
    outputReceiptSha256: sourceContractSha256("act"),
    transitionedAt: "2026-09-06T02:02:00.000Z",
  });
  current = advanceLoopV2Checkpoint({
    current,
    executionScope: scopeFor(root),
    trigger: "action_succeeded",
    outputReceiptSha256: sourceContractSha256("observe"),
    transitionedAt: "2026-09-06T02:03:00.000Z",
  });
  current = advanceLoopV2Checkpoint({
    current,
    executionScope: scopeFor(root),
    trigger: "observation_recorded",
    outputReceiptSha256: sourceContractSha256("verify"),
    transitionedAt: "2026-09-06T02:04:00.000Z",
  });
  return advanceLoopV2Checkpoint({
    current,
    executionScope: scopeFor(root),
    trigger: "verification_passed",
    outputReceiptSha256: sourceContractSha256(receipt),
    transitionedAt: "2026-09-06T02:05:00.000Z",
  });
}

function scopeFor(root: ReturnType<typeof initial>) {
  return scope(root.enginePin.capabilityId === LOOP_V2_CAPABILITY_ID
    ? "read"
    : root.enginePin.capabilityId === LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID
      ? "context"
      : "model");
}

function scope(kind: "read" | "model" | "context") {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "run-a",
    purpose: kind === "read"
      ? "agent.loop.v2.read_only_canary"
      : kind === "context"
        ? "agent.loop.v2.context_text_canary"
        : "agent.loop.v2.model_text_canary",
  });
}

function rollout(
  kind: "read" | "model" | "context",
): TenantCapabilityRollout {
  const model = kind === "model";
  const context = kind === "context";
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: context
      ? LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID
      : model
      ? LOOP_V2_MODEL_TEXT_CAPABILITY_ID
      : LOOP_V2_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: context
      ? LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID
      : model
      ? LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID
      : LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: context
      ? LOOP_V2_CONTEXT_TEXT_CONFIGURATION_SHA256
      : model
      ? LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256
      : LOOP_V2_CONFIGURATION_SHA256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: "actor-a",
    activatedByActorId: "actor-a",
    activatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
