import { describe, expect, it } from "vitest";
import {
  EFFECT_RECEIPT_SCHEMA_VERSION,
  MAX_EFFECT_RECEIPT_EVENT_PAYLOAD_BYTES,
  buildEffectReceiptEventPayloadV1,
  buildEffectReceiptV1,
  canonicalJsonSha256,
  effectReceiptEventPayloadV1Schema,
  idempotencyKeySha256,
  memoryEffectTargetIdV1,
  parseEffectReceiptV1,
  type BuildEffectReceiptV1Input,
} from "@/lib/tools/effect-receipt";

const PRIVATE_TITLE = "Private board decision";
const PRIVATE_CONTENT = "The confidential launch date is next quarter.";
const PRIVATE_PLAN_STEP = "Persist the confidential decision as memory.";
const PRIVATE_IDEMPOTENCY_KEY = "workflow-private-retry-key";

function receiptInput(
  overrides: Partial<BuildEffectReceiptV1Input> = {},
): BuildEffectReceiptV1Input {
  const tenantId = "tenant_effect_test";
  const executionId = "tool_execution_effect_test";
  const workflowRunId = "workflow_run_effect_test";
  const input = {
    title: PRIVATE_TITLE,
    content: PRIVATE_CONTENT,
    type: "fact",
    tags: ["private", "launch"],
  };
  const plan = {
    id: "plan_effect_test",
    nodes: [{ id: "node_memory_write", instruction: PRIVATE_PLAN_STEP }],
  };
  const planSha256 = canonicalJsonSha256(plan);
  const inputSha256 = canonicalJsonSha256(input);
  const idempotencyDigest = idempotencyKeySha256({
    tenantId,
    idempotencyKey: PRIVATE_IDEMPOTENCY_KEY,
  });
  const targetId = memoryEffectTargetIdV1({
    tenantId,
    executionId,
    workflowRunId,
    planId: plan.id,
    planSha256,
    planNodeId: plan.nodes[0].id,
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
  });
  const targetState = {
    id: targetId,
    tenantId,
    title: PRIVATE_TITLE,
    content: PRIVATE_CONTENT,
    type: "fact",
    claimStatus: "active",
  };
  const targetStateSha256 = canonicalJsonSha256(targetState);
  return {
    effectMode: "live",
    reversible: true,
    executionId,
    tenantId,
    actorId: "actor_effect_test",
    executingPrincipalType: "system",
    executingPrincipalId: `workflow:${workflowRunId}`,
    workflowRunId,
    planId: plan.id,
    planSha256,
    planNodeId: plan.nodes[0].id,
    toolId: "memory.write",
    toolContractSha256: canonicalJsonSha256({
      id: "memory.write",
      riskLevel: 1,
      reversible: true,
      approvalRequired: false,
    }),
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
    targetType: "memory",
    targetId,
    providerAcknowledgement: "first_party_store_commit",
    providerAcknowledgementId: targetId,
    providerAcknowledgementSha256: canonicalJsonSha256({
      provider: "first_party_memory_store",
      committedTarget: targetState,
    }),
    verificationMethod: "read_after_write",
    verificationState: "verified",
    verificationReasonCode: "state_matched",
    expectedTargetStateSha256: targetStateSha256,
    observedTargetStateSha256: targetStateSha256,
    ...overrides,
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .reverse()
      .map((key) => [key, reverseObjectKeys(record[key])]),
  );
}

describe("effect receipt v1", () => {
  it("builds a deterministic live, reversible memory-write receipt", () => {
    const input = receiptInput();
    const receipt = buildEffectReceiptV1(input);
    const repeated = buildEffectReceiptV1(input);
    const { receiptSha256, ...body } = receipt;

    expect(receipt).toEqual(repeated);
    expect(receipt.schemaVersion).toBe(EFFECT_RECEIPT_SCHEMA_VERSION);
    expect(receipt.receiptKind).toBe("effect_receipt");
    expect(receipt.effectReceiptId).toMatch(/^effect_[a-f0-9]{56}$/);
    expect(receipt.effectMode).toBe("live");
    expect(receipt.reversible).toBe(true);
    expect(receipt.toolId).toBe("memory.write");
    expect(receipt.targetType).toBe("memory");
    expect(receipt.providerAcknowledgement).toBe(
      "first_party_store_commit",
    );
    expect(receipt.verificationState).toBe("verified");
    expect(receiptSha256).toBe(canonicalJsonSha256(body));
    expect(parseEffectReceiptV1(receipt)).toEqual(receipt);
  });

  it("hashes recursive JSON canonically and scopes idempotency digests", () => {
    const value = {
      z: [{ second: 2, first: 1 }],
      a: { beta: true, alpha: "value" },
    };
    const reordered = reverseObjectKeys(value);

    expect(canonicalJsonSha256(reordered)).toBe(canonicalJsonSha256(value));
    expect(canonicalJsonSha256(["a", "b"])).not.toBe(
      canonicalJsonSha256(["b", "a"]),
    );
    expect(idempotencyKeySha256({
      tenantId: "tenant_one",
      idempotencyKey: "retry_key",
    })).toBe(idempotencyKeySha256({
      tenantId: "tenant_one",
      idempotencyKey: " retry_key ",
    }));
    expect(idempotencyKeySha256({
      tenantId: "tenant_one",
      idempotencyKey: "retry_key",
    })).not.toBe(idempotencyKeySha256({
      tenantId: "tenant_two",
      idempotencyKey: "retry_key",
    }));
  });

  it("survives recursive JSONB-style key reordering", () => {
    const receipt = buildEffectReceiptV1(receiptInput());

    expect(parseEffectReceiptV1(reverseObjectKeys(receipt))).toEqual(receipt);
  });

  it("rejects digest tampering, re-signing, unknown fields, and null", () => {
    const receipt = buildEffectReceiptV1(receiptInput());
    const changedWithoutDigest = { ...receipt, targetId: "memory_other" };
    const { receiptSha256: _receiptSha256, ...changedBody } =
      changedWithoutDigest;
    const changedAndResigned = {
      ...changedBody,
      receiptSha256: canonicalJsonSha256(changedBody),
    };

    expect(() => parseEffectReceiptV1(changedWithoutDigest)).toThrow();
    expect(() => parseEffectReceiptV1(changedAndResigned)).toThrow(
      /ID does not match/i,
    );
    expect(() => parseEffectReceiptV1({
      ...receipt,
      rawInput: { content: PRIVATE_CONTENT },
    })).toThrow();
    expect(() => parseEffectReceiptV1(null)).toThrow();
    expect(parseEffectReceiptV1(undefined)).toBeUndefined();
  });

  it("fails closed when a valid receipt is replayed across its bindings", () => {
    const receipt = buildEffectReceiptV1(receiptInput());

    expect(() => parseEffectReceiptV1(receipt, {
      tenantId: "tenant_other",
    })).toThrow(/different tenant id/i);
    expect(() => parseEffectReceiptV1(receipt, {
      executionId: "tool_execution_other",
    })).toThrow(/different execution id/i);
    expect(() => parseEffectReceiptV1(receipt, {
      planId: "plan_other",
    })).toThrow(/different plan id/i);
    expect(() => parseEffectReceiptV1(receipt, {
      inputSha256: "0".repeat(64),
    })).toThrow(/different input sha256/i);
    expect(parseEffectReceiptV1(receipt, {
      tenantId: receipt.tenantId,
      actorId: receipt.actorId,
      executingPrincipalId: receipt.executingPrincipalId,
      workflowRunId: receipt.workflowRunId,
      planId: receipt.planId,
      planSha256: receipt.planSha256,
      toolContractSha256: receipt.toolContractSha256,
      inputSha256: receipt.inputSha256,
      idempotencyKeySha256: receipt.idempotencyKeySha256,
      targetId: receipt.targetId,
    })).toEqual(receipt);
  });

  it("accepts only honest read-after-write state combinations", () => {
    const otherState = canonicalJsonSha256({ state: "other" });
    const missing = buildEffectReceiptV1(receiptInput({
      verificationState: "failed",
      verificationReasonCode: "target_missing",
      observedTargetStateSha256: null,
    }));
    const mismatched = buildEffectReceiptV1(receiptInput({
      verificationState: "failed",
      verificationReasonCode: "state_mismatch",
      observedTargetStateSha256: otherState,
    }));
    const unverifiable = buildEffectReceiptV1(receiptInput({
      verificationState: "unverifiable",
      verificationReasonCode: "read_failed",
      observedTargetStateSha256: null,
    }));

    expect(missing.verificationState).toBe("failed");
    expect(mismatched.verificationState).toBe("failed");
    expect(unverifiable.verificationState).toBe("unverifiable");

    expect(() => buildEffectReceiptV1(receiptInput({
      observedTargetStateSha256: otherState,
    }))).toThrow(/must match/i);
    expect(() => buildEffectReceiptV1(receiptInput({
      verificationState: "failed",
      verificationReasonCode: "state_mismatch",
    }))).toThrow(/missing or mismatched/i);
    expect(() => buildEffectReceiptV1(receiptInput({
      verificationState: "unverifiable",
      verificationReasonCode: "read_failed",
    }))).toThrow(/cannot claim an observed/i);
  });

  it("strictly rejects dry-run and unsupported effect semantics", () => {
    const input = receiptInput();
    const receipt = buildEffectReceiptV1(input);

    expect(() => buildEffectReceiptV1({
      ...input,
      effectMode: "dry_run",
    } as unknown as BuildEffectReceiptV1Input)).toThrow();
    expect(() => parseEffectReceiptV1({
      ...receipt,
      reversible: false,
    })).toThrow();
    expect(() => parseEffectReceiptV1({
      ...receipt,
      providerAcknowledgement: "model_assertion",
    })).toThrow();
    expect(() => parseEffectReceiptV1({
      ...receipt,
      dryRun: false,
    })).toThrow();
  });

  it("builds compact metadata-only event evidence", () => {
    const receipt = buildEffectReceiptV1(receiptInput());
    const payload = buildEffectReceiptEventPayloadV1(receipt);
    const serialized = JSON.stringify(payload);

    expect(effectReceiptEventPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.payloadKind).toBe("effect_receipt");
    expect(payload.effectReceiptId).toBe(receipt.effectReceiptId);
    expect(payload.effectReceiptSha256).toBe(receipt.receiptSha256);
    expect(payload.providerAcknowledgement).toBe(
      "first_party_store_commit",
    );
    expect(payload.verificationState).toBe("verified");
    expect(payload).not.toHaveProperty("providerAcknowledgementId");
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
      MAX_EFFECT_RECEIPT_EVENT_PAYLOAD_BYTES,
    );
    expect(serialized).not.toContain(PRIVATE_TITLE);
    expect(serialized).not.toContain(PRIVATE_CONTENT);
    expect(serialized).not.toContain(PRIVATE_PLAN_STEP);
    expect(serialized).not.toContain(PRIVATE_IDEMPOTENCY_KEY);
    expect(() => effectReceiptEventPayloadV1Schema.parse({
      ...payload,
      rawProviderOutput: PRIVATE_CONTENT,
    })).toThrow();
  });
});
