import { describe, expect, it } from "vitest";
import {
  buildEffectIntentV2,
  finalizeEffectIntentV2,
  parseEffectIntentV2,
  type BuildEffectIntentV2Input,
} from "@/lib/tools/effect-intent-v2";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function intentInput(
  overrides: Partial<BuildEffectIntentV2Input> = {},
): BuildEffectIntentV2Input {
  return {
    effectMode: "live",
    reversible: false,
    executionKind: "direct",
    executionId: "execution:http-post",
    tenantId: "tenant:alpha",
    actorId: "actor:owner",
    executingPrincipalType: "user",
    executingPrincipalId: "actor:owner",
    workflowRunId: null,
    planId: null,
    planSha256: null,
    planNodeId: null,
    toolId: "http.request",
    toolContractSha256: sha("a"),
    approvalState: "approved",
    approvalBindingSha256: sha("b"),
    inputSha256: sha("c"),
    idempotencyKeySha256: sha("d"),
    targetType: "http_endpoint",
    targetId: "http_target:one",
    expectedTargetStateSha256: sha("e"),
    ...overrides,
  };
}

describe("effect intent v2", () => {
  it("persists every material binding before finalization", () => {
    const intent = buildEffectIntentV2(intentInput());
    expect(buildEffectIntentV2(intentInput())).toEqual(intent);
    expect(parseEffectIntentV2(intent)).toEqual(intent);

    const receipt = finalizeEffectIntentV2(intent, {
      providerAcknowledgement: "provider_response",
      providerAcknowledgementId: "provider:request-1",
      providerAcknowledgementSha256: sha("f"),
      verificationMethod: "read_after_write",
      verificationState: "unverifiable",
      verificationReasonCode: "read_unavailable",
      observedTargetStateSha256: null,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      executionId: intent.executionId,
      toolId: intent.toolId,
      approvalBindingSha256: intent.approvalBindingSha256,
      inputSha256: intent.inputSha256,
      targetId: intent.targetId,
      verificationState: "unverifiable",
    });
  });

  it("cannot finalize a tampered intent or false verified evidence", () => {
    const intent = buildEffectIntentV2(intentInput());
    expect(() => finalizeEffectIntentV2({
      ...intent,
      targetId: "http_target:changed",
    }, {
      providerAcknowledgement: "provider_response",
      providerAcknowledgementId: "provider:request-1",
      providerAcknowledgementSha256: sha("f"),
      verificationMethod: "read_after_write",
      verificationState: "unverifiable",
      verificationReasonCode: "read_unavailable",
      observedTargetStateSha256: null,
    })).toThrow(/digest|ID does not match/i);

    expect(() => finalizeEffectIntentV2(intent, {
      providerAcknowledgement: "provider_response",
      providerAcknowledgementId: "provider:request-1",
      providerAcknowledgementSha256: sha("f"),
      verificationMethod: "read_after_write",
      verificationState: "verified",
      verificationReasonCode: "state_matched",
      observedTargetStateSha256: sha("0"),
    })).toThrow(/exactly match/i);
  });

  it("rejects partial workflow and approval bindings", () => {
    expect(() => buildEffectIntentV2(intentInput({
      executionKind: "workflow",
      workflowRunId: "run-1",
      executingPrincipalType: "system",
      executingPrincipalId: "workflow:run-1",
    }))).toThrow(/every workflow plan binding/i);
    expect(() => buildEffectIntentV2(intentInput({
      approvalState: "not_required",
    }))).toThrow(/approval state and binding/i);
  });
});
