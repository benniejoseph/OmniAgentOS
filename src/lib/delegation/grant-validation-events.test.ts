import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.append,
  listStreamEvents: mocks.list,
}));

import {
  appendDelegationGrantValidation,
  getLatestDelegationGrantValidation,
} from "@/lib/delegation/grant-validation-events";
import { buildDelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import { buildExecutionContract } from "@/lib/delegation/test-fixtures";

const execution = buildDelegationExecutionRecordV1({
  contract: buildExecutionContract(),
  budgetLedgerRevision: 1,
});
const scope = executionScopeFromDelegationContract(execution.contract);

describe("delegation grant-validation events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.append.mockResolvedValue({ id: "event-one" });
    mocks.list.mockResolvedValue([]);
  });

  it("persists only a content-free exact-contract receipt", async () => {
    await appendDelegationGrantValidation({
      execution,
      executionScope: scope,
      status: "changed",
      validatedAt: "2026-09-22T13:00:00.000Z",
    });

    const call = mocks.append.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      streamId: `delegation-execution:${execution.delegationId}`,
      type: "delegation.grants.validated",
      payload: {
        executionId: execution.executionId,
        contractSha256: execution.contractSha256,
        status: "changed",
        category: "capability_binding",
        contentIncluded: false,
        grantsAuthority: false,
      },
    });
    expect(JSON.stringify(call)).not.toMatch(
      /instructions|guidance|credential|exception|manifest_payload/i,
    );
  });

  it("returns only the latest exact actor-owned contract validation", async () => {
    mocks.list.mockResolvedValue([
      {
        type: "delegation.grants.validated",
        payload: validationPayload({ contractSha256: "0".repeat(64) }),
      },
      {
        type: "delegation.grants.validated",
        payload: validationPayload({ status: "current" }),
      },
    ]);

    const result = await getLatestDelegationGrantValidation({
      tenantId: execution.tenantId,
      ownerActorId: execution.ownerActorId,
      executionId: execution.executionId,
      delegationId: execution.delegationId,
      contractSha256: execution.contractSha256,
    });

    expect(mocks.list).toHaveBeenCalledWith(
      `delegation-execution:${execution.delegationId}`,
      expect.objectContaining({
        tenantId: execution.tenantId,
        actorId: execution.ownerActorId,
        order: "desc",
      }),
    );
    expect(result).toEqual({
      status: "current",
      category: "all_grants",
      validatedAt: "2026-09-22T13:00:00.000Z",
    });
  });

  it("does not infer current authority when no durable receipt exists", async () => {
    await expect(getLatestDelegationGrantValidation({
      tenantId: execution.tenantId,
      ownerActorId: execution.ownerActorId,
      executionId: execution.executionId,
      delegationId: execution.delegationId,
      contractSha256: execution.contractSha256,
    })).resolves.toEqual({
      status: "not_checked",
      category: null,
      validatedAt: null,
    });
  });
});

function validationPayload(input: {
  status?: "current" | "changed";
  contractSha256?: string;
} = {}) {
  const status = input.status || "changed";
  return {
    schemaVersion: 1,
    version: "delegation-grant-validation:1",
    executionId: execution.executionId,
    delegationId: execution.delegationId,
    contractSha256: input.contractSha256 || execution.contractSha256,
    status,
    category: status === "current" ? "all_grants" : "capability_binding",
    validatedAt: "2026-09-22T13:00:00.000Z",
    contentIncluded: false,
    grantsAuthority: false,
  };
}
