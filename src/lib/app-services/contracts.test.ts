import { describe, expect, it } from "vitest";
import {
  appServiceReceiptSchema,
  authorizeAppServiceCall,
  completeAppServiceCall,
  createAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  APP_SERVICE_OPERATION_CONTRACTS,
  getAppServiceOperationContract,
  validateAppServiceRegistry,
} from "@/lib/app-services/registry";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "operator",
  source: "service",
};

function scope(overrides: Partial<Parameters<typeof createExecutionScope>[0]> = {}) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "agent-main",
    correlationId: "correlation-a",
    purpose: "app-service-test",
    ...overrides,
  });
}

describe("P9.1 application service boundary", () => {
  it("authorizes a transport-neutral read and emits a content-free receipt", () => {
    const authorized = authorizeAppServiceCall(
      createAppServiceCaller({ context, executionScope: scope() }),
      getAppServiceOperationContract("runs.list"),
    );
    const result = completeAppServiceCall(
      authorized,
      { runs: [{ id: "run-secret", response: "private result" }] },
      { occurredAt: "2026-09-07T00:00:00.000Z" },
    );

    expect(result.data.runs).toHaveLength(1);
    expect(result.receipt).toMatchObject({
      operation: "runs.list",
      accessMode: "read",
      eventContract: "read_only:no_domain_mutation",
      idempotencyKeySha256: null,
      resourceCount: 1,
    });
    expect(JSON.stringify(result.receipt)).not.toContain("private result");
    expect(appServiceReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
  });

  it("requires actor-bound scope and opaque idempotency for mutations", () => {
    const contract = getAppServiceOperationContract("mission.task.create");
    expect(() => authorizeAppServiceCall(
      createAppServiceCaller({ context }),
      contract,
    )).toThrow("exact execution scope");
    expect(() => authorizeAppServiceCall(
      createAppServiceCaller({ context, executionScope: scope() }),
      contract,
    )).toThrow("idempotency key");

    const authorized = authorizeAppServiceCall(
      createAppServiceCaller({
        context,
        executionScope: scope(),
        idempotencyKey: "mission-task-1",
      }),
      contract,
    );
    expect(authorized.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(authorized)).toContain("mission-task-1");
    const result = completeAppServiceCall(authorized, { taskId: "task-a" });
    expect(JSON.stringify(result.receipt)).not.toContain("mission-task-1");
  });

  it("rejects cross-tenant and cross-actor execution scopes", () => {
    expect(() => createAppServiceCaller({
      context,
      executionScope: scope({ tenantId: "tenant-b" }),
    })).toThrow("different tenant");
    expect(() => createAppServiceCaller({
      context,
      executionScope: scope({ initiatingActorId: "actor-b" }),
    })).toThrow("different actor");
  });

  it("keeps every registered mutation evented and exposes no agent DOM or database path", () => {
    const validation = validateAppServiceRegistry();
    expect(validation).toMatchObject({
      operationCount: APP_SERVICE_OPERATION_CONTRACTS.length,
      duplicateOperations: [],
      invalidMutationContracts: [],
      agentAccessPaths: ["governed_tool_executor", "application_service"],
      forbiddenAgentAccessPaths: [],
      passed: true,
    });
    expect(validation.mutationCount).toBeGreaterThan(0);
    expect(validation.registrySha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
