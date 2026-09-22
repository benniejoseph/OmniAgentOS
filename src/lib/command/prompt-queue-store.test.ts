import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  transaction: vi.fn(),
  appendEvent: vi.fn(),
  openPayload: vi.fn(),
  resolveIdentity: vi.fn(),
  resolveRuntime: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => Object.assign(mocks.sql, { transaction: mocks.transaction }),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendEvent,
}));
vi.mock("@/lib/security/sealed-payload", () => ({
  sealJsonPayload: (value: unknown, binding: string) => ({ value, binding }),
  openJsonPayload: mocks.openPayload,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveAgentIdentityForExecution: mocks.resolveIdentity,
}));
vi.mock("@/lib/openai/model-router", () => ({
  selectAgentModel: mocks.selectModel,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntime,
}));
vi.mock("@/lib/orchestration/computer-use-routing", () => ({
  modelAssignmentScopeForAgent: (agentId: string, computerUse: boolean) =>
    `agent:${agentId}:${computerUse ? "computer" : "standard"}`,
}));

import {
  claimPromptQueueDispatch,
  createPromptQueueItem,
  inspectPromptQueueDispatchReceipt,
  listPromptQueueItems,
  recordPromptQueueDispatchProgress,
  reconcileExpiredPromptQueueDispatches,
  reorderPromptQueueItems,
  updatePromptQueueItem,
  validatePromptQueueDispatch,
  type PromptQueueAuthority,
} from "@/lib/command/prompt-queue-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { runtimeModelRoutingPolicySha256 } from "@/lib/settings/runtime-model-routing-pin";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const tenantId = "tenant-queue";
const actorId = "actor-queue";
const requestActorId = "queue-owner@example.test";
const authority: PromptQueueAuthority = {
  tenantId,
  ownerActorId: actorId,
  requestActorId,
  sessionId: "session-queue",
  executionScope: createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: "prompt-queue-test",
    purpose: "prompt_queue.test",
  }),
};

describe("persistent prompt queue store fences", () => {
  beforeEach(() => {
    mocks.sql.mockReset();
    mocks.transaction.mockReset();
    mocks.appendEvent.mockReset();
    mocks.openPayload.mockReset();
    mocks.resolveIdentity.mockReset();
    mocks.resolveRuntime.mockReset();
    mocks.selectModel.mockReset();
    mocks.transaction.mockImplementation(
      async (operation: (sql: typeof mocks.sql) => unknown) =>
        operation(mocks.sql),
    );
    mocks.openPayload.mockImplementation((sealed: unknown) => {
      if (!sealed || typeof sealed !== "object") {
        throw new Error("sealed payload missing");
      }
      return (sealed as { value: unknown }).value;
    });
    mocks.resolveIdentity.mockResolvedValue(identity());
    mocks.selectModel.mockReturnValue({
      provider: "openai",
      model: "gpt-test",
      fallbackModel: "gpt-test-fallback",
      reason: "test",
      tier: "reasoning",
    });
    mocks.resolveRuntime.mockResolvedValue({
      configured: true,
      provider: "openai",
      model: "gpt-test",
      scope: "agent:atlas:standard",
      source: "deployment_environment",
      assignmentId: null,
      assignmentRevision: null,
      assignmentConfigurationSha256: null,
    });
    mocks.appendEvent.mockResolvedValue(undefined);
  });

  it("keeps reads actor-bound and rejects any row that claims queue authority", async () => {
    const item = row();
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item]);

    await expect(listPromptQueueItems(authority)).resolves.toHaveLength(1);
    const listCall = mocks.sql.mock.calls.find(([parts]) =>
      (parts as TemplateStringsArray).join("?").includes("state <> 'deleted'"));
    expect(listCall?.[0].join("?")).toContain("tenant_id = ?");
    expect(listCall?.[0].join("?")).toContain("owner_actor_id = ?");
    expect(listCall?.slice(1)).toEqual(expect.arrayContaining([tenantId, actorId]));

    mocks.sql.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...item, queue_grants_authority: true }]);
    await expect(listPromptQueueItems(authority)).rejects.toThrow();
  });

  it("rejects a serialized preflight-full queue before resolving pins", async () => {
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 40 }]);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("capacity-check"),
    })).rejects.toMatchObject({ code: "capacity" });

    const statements = mocks.sql.mock.calls.map(([parts]) =>
      (parts as TemplateStringsArray).join("?"));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements[1]).toContain("client_correlation_id");
    expect(statements[2]).toContain("COUNT(*)");
    expect(mocks.sql.mock.calls[2]?.slice(1)).toEqual([tenantId, actorId]);
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("rechecks capacity authoritatively under the actor lock", async () => {
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 39 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 40 }]);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("capacity-race"),
    })).rejects.toMatchObject({ code: "capacity" });

    const statements = mocks.sql.mock.calls.map(([parts]) =>
      (parts as TemplateStringsArray).join("?"));
    expect(statements[3]).toContain("pg_advisory_xact_lock");
    expect(statements[4]).toContain("client_correlation_id");
    expect(statements[5]).toContain("COUNT(*)");
    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("resolves and freezes pins before the queue transaction owns the sole slot", async () => {
    const request = createRequest("pins-before-transaction");
    const created = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    const order: string[] = [];
    let transactionOwnsSlot = false;
    mocks.resolveIdentity.mockImplementation(async () => {
      expect(transactionOwnsSlot).toBe(false);
      order.push("identity");
      return identity();
    });
    mocks.resolveRuntime.mockImplementation(async () => {
      expect(transactionOwnsSlot).toBe(false);
      order.push("runtime");
      return {
        configured: true,
        provider: "openai",
        model: "gpt-test",
        scope: "agent:atlas:standard",
        source: "deployment_environment",
        assignmentId: null,
        assignmentRevision: null,
        assignmentConfigurationSha256: null,
      };
    });
    let transactionNumber = 0;
    mocks.transaction.mockImplementation(async (
      operation: (sql: typeof mocks.sql) => unknown,
    ) => {
      transactionNumber += 1;
      order.push(transactionNumber === 1
        ? "transaction:preflight"
        : "transaction:mutation");
      transactionOwnsSlot = true;
      try {
        return await operation(mocks.sql);
      } finally {
        transactionOwnsSlot = false;
      }
    });
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ position: 0 }])
      .mockResolvedValueOnce([created]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({ id: created.id }),
      created: true,
    });

    expect(order).toEqual([
      "transaction:preflight",
      "identity",
      "runtime",
      "transaction:mutation",
    ]);
    const insertCall = mocks.sql.mock.calls.find(([parts]) =>
      (parts as TemplateStringsArray).join("?").includes("INSERT INTO"));
    expect(mocks.resolveIdentity).toHaveBeenCalledWith({
      tenantId,
      actorId: requestActorId,
      agentId: "atlas",
    });
    expect(insertCall?.[3]).toBe(actorId);
    expect(insertCall?.[7]).toMatchObject({
      binding: expect.stringContaining(`:${actorId}:`),
    });
    expect(Object.isFrozen(insertCall?.[14])).toBe(true);
    expect(Object.isFrozen(insertCall?.[15])).toBe(true);
  });

  it("does not treat a pin-resolution close as a replayable queue transaction", async () => {
    const closed = Object.assign(new Error("pin lookup pool closed"), {
      code: "DATABASE_CONNECTION_CLOSED",
    });
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    mocks.resolveIdentity.mockRejectedValueOnce(closed);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("pin-resolution-close"),
    })).rejects.toBe(closed);

    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.sql).toHaveBeenCalledTimes(3);
  });

  it("returns a deterministic conflict for a deleted correlation without opening NULL", async () => {
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...row({ state: "deleted" }), sealed_prompt: null },
      ]);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("deleted-correlation"),
    })).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.openPayload).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it("reconciles a retry after the create transaction committed but its response was lost", async () => {
    const request = createRequest("correlation-one");
    const existing = row({
      target_sha256: canonicalJsonSha256(request.target),
    });
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existing]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({ id: existing.id, state: "queued" }),
      created: false,
    });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.sql.mock.calls[1]?.slice(1)).toEqual([
      tenantId,
      actorId,
      request.clientCorrelationId,
    ]);
  });

  it("returns an exact duplicate that commits as the 40th item while preflight waits", async () => {
    const request = createRequest("duplicate-as-final-slot");
    const existing = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    let duplicateCommitted = false;
    let releaseActorLock!: (rows: unknown[]) => void;
    const actorLock = new Promise<unknown[]>((resolve) => {
      releaseActorLock = resolve;
    });
    mocks.sql.mockImplementation((parts: TemplateStringsArray) => {
      const statement = parts.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return actorLock;
      if (statement.includes("client_correlation_id")) {
        expect(duplicateCommitted).toBe(true);
        return Promise.resolve([existing]);
      }
      if (statement.includes("COUNT(*)")) {
        return Promise.resolve([{ count: 40 }]);
      }
      throw new Error(`Unexpected queue statement: ${statement}`);
    });

    const pending = createPromptQueueItem({ authority, request });
    await vi.waitFor(() => expect(mocks.sql).toHaveBeenCalledOnce());
    duplicateCommitted = true;
    releaseActorLock([]);

    await expect(pending).resolves.toEqual({
      item: expect.objectContaining({ id: existing.id }),
      created: false,
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.sql.mock.calls.some(([parts]) =>
      (parts as TemplateStringsArray).join("?").includes("COUNT(*)"))).toBe(false);
  });

  it("retries one exact pre-commit close during the read-only preflight", async () => {
    const request = createRequest("preflight-close-retry");
    const created = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    const closed = Object.assign(new Error("preflight pool closed"), {
      code: "DATABASE_CONNECTION_CLOSED",
    });
    mocks.transaction
      .mockRejectedValueOnce(closed)
      .mockImplementation(
        async (operation: (sql: typeof mocks.sql) => unknown) =>
          operation(mocks.sql),
      );
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ position: 0 }])
      .mockResolvedValueOnce([created]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({
        clientCorrelationId: request.clientCorrelationId,
      }),
      created: true,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveRuntime).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledOnce();
  });

  it("never retries a second exact close during the read-only preflight", async () => {
    const closed = Object.assign(new Error("preflight pool closed"), {
      code: "DATABASE_CONNECTION_CLOSED",
    });
    mocks.transaction
      .mockRejectedValueOnce(closed)
      .mockRejectedValueOnce(closed);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("preflight-close-limit"),
    })).rejects.toBe(closed);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.resolveRuntime).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("never replays an indeterminate read-only preflight commit", async () => {
    const unknownCommit = Object.assign(new Error("preflight commit unknown"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
      retryable: false,
    });
    mocks.transaction.mockRejectedValueOnce(unknownCommit);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("preflight-unknown-commit"),
    })).rejects.toBe(unknownCommit);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.resolveRuntime).not.toHaveBeenCalled();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("rechecks correlation under the actor lock after a pre-read miss", async () => {
    const request = createRequest("correlation-race");
    const existing = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existing]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({ id: existing.id }),
      created: false,
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.sql).toHaveBeenCalledTimes(5);
  });

  it("retries one pre-commit closed generation with the same queue identity", async () => {
    const request = createRequest("closed-generation-retry");
    const created = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    const closed = Object.assign(new Error("pool closed"), {
      code: "DATABASE_CONNECTION_CLOSED",
    });
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ position: 0 }])
      .mockRejectedValueOnce(closed)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ position: 0 }])
      .mockResolvedValueOnce([created]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({
        clientCorrelationId: request.clientCorrelationId,
        state: "queued",
      }),
      created: true,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveRuntime).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledOnce();
    const insertCalls = mocks.sql.mock.calls.filter(([parts]) =>
      (parts as TemplateStringsArray).join("?").includes("INSERT INTO"));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[1]?.[1]).toBe(insertCalls[0]?.[1]);
    expect(insertCalls[1]?.[7]).toBe(insertCalls[0]?.[7]);
    expect(insertCalls[1]?.[14]).toBe(insertCalls[0]?.[14]);
    expect(insertCalls[1]?.[15]).toBe(insertCalls[0]?.[15]);
  });

  it("never retries a second pre-commit generation close", async () => {
    const closed = Object.assign(new Error("pool closed"), {
      code: "DATABASE_CONNECTION_CLOSED",
    });
    mocks.transaction
      .mockImplementationOnce(
        async (operation: (sql: typeof mocks.sql) => unknown) =>
          operation(mocks.sql),
      )
      .mockRejectedValueOnce(closed)
      .mockRejectedValueOnce(closed);
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("closed-generation-limit"),
    })).rejects.toBe(closed);
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.sql).toHaveBeenCalledTimes(3);
    expect(mocks.resolveIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveRuntime).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("reconciles but never replays an indeterminate create commit", async () => {
    const request = createRequest("unknown-commit-receipt");
    const existing = row({
      client_correlation_id: request.clientCorrelationId,
      target_sha256: canonicalJsonSha256(request.target),
    });
    const unknownCommit = Object.assign(new Error("commit outcome unknown"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
      retryable: false,
    });
    mocks.transaction
      .mockImplementationOnce(
        async (operation: (sql: typeof mocks.sql) => unknown) =>
          operation(mocks.sql),
      )
      .mockRejectedValueOnce(unknownCommit);
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([existing]);

    await expect(createPromptQueueItem({ authority, request })).resolves.toEqual({
      item: expect.objectContaining({
        id: existing.id,
        clientCorrelationId: request.clientCorrelationId,
      }),
      created: false,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.sql).toHaveBeenCalledTimes(4);
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("preserves an indeterminate commit when no durable receipt exists", async () => {
    const unknownCommit = Object.assign(new Error("commit outcome unknown"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
      retryable: false,
    });
    mocks.transaction
      .mockImplementationOnce(
        async (operation: (sql: typeof mocks.sql) => unknown) =>
          operation(mocks.sql),
      )
      .mockRejectedValueOnce(unknownCommit);
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]);

    await expect(createPromptQueueItem({
      authority,
      request: createRequest("unknown-commit-missing"),
    })).rejects.toBe(unknownCommit);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.sql).toHaveBeenCalledTimes(4);
  });

  it("edits a paused item but rejects a stale lifecycle revision before update", async () => {
    const paused = row({ state: "paused", lifecycle_revision: 2 });
    const edited = row({
      state: "paused",
      lifecycle_revision: 3,
      prompt: "Edited while paused",
    });
    mocks.sql
      .mockResolvedValueOnce([paused])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([paused])
      .mockResolvedValueOnce([edited]);

    await expect(updatePromptQueueItem({
      authority,
      itemId: String(paused.id),
      expectedRevision: 2,
      prompt: "Edited while paused",
    })).resolves.toMatchObject({
      state: "paused",
      prompt: "Edited while paused",
      lifecycleRevision: 3,
    });
    const editStatement = mocks.sql.mock.calls[3]?.[0].join("?");
    expect(editStatement).toContain("dispatch_token_sha256 = CASE");
    expect(editStatement).toContain("dispatch_lease_expires_at = CASE");
    expect(editStatement).toContain("dispatched_at = CASE");

    mocks.sql.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([paused]);
    await expect(updatePromptQueueItem({
      authority,
      itemId: String(paused.id),
      expectedRevision: 1,
      state: "queued",
    })).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.sql.mock.calls).toHaveLength(2);
  });

  it("revision-fences the complete reorder set before any position changes", async () => {
    const first = row({ id: "00000000-0000-4000-8000-000000000001" });
    const second = row({
      id: "00000000-0000-4000-8000-000000000002",
      lifecycle_revision: 4,
    });
    mocks.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([first, second]);

    await expect(reorderPromptQueueItems({
      authority,
      items: [
        { id: String(second.id), expectedRevision: 3 },
        { id: String(first.id), expectedRevision: 0 },
      ],
    })).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.sql.mock.calls).toHaveLength(2);
    expect(mocks.sql.mock.calls[0]?.[0].join("?")).toContain(
      "pg_advisory_xact_lock",
    );
  });

  it("revalidates pins and fences an edit or delete before dispatch claim", async () => {
    const current = row();
    const edited = row({
      prompt: "Changed after validation",
      prompt_sha256: "b".repeat(64),
    });
    mocks.sql.mockResolvedValueOnce([current]).mockResolvedValueOnce([edited]);

    await expect(claimPromptQueueDispatch({
      authority,
      itemId: String(current.id),
      expectedRevision: 0,
      force: false,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.sql.mock.calls).toHaveLength(2);

    mocks.sql.mockReset().mockResolvedValueOnce([]);
    await expect(claimPromptQueueDispatch({
      authority,
      itemId: String(current.id),
      expectedRevision: 0,
      force: false,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects same-model assignment revision drift before dispatch", async () => {
    const assignmentConfigurationSha256 = "9".repeat(64);
    const current = row({
      model_pin: modelPin({
        source: "tenant_assignment",
        assignmentId: "assignment-atlas",
        assignmentRevision: 4,
        assignmentConfigurationSha256,
      }),
    });
    mocks.resolveRuntime.mockResolvedValue({
      configured: true,
      provider: "openai",
      model: "gpt-test",
      scope: "agent:atlas:standard",
      source: "tenant_assignment",
      assignmentId: "assignment-atlas",
      assignmentRevision: 5,
      assignmentConfigurationSha256,
    });
    mocks.sql.mockResolvedValueOnce([current]);

    await expect(claimPromptQueueDispatch({
      authority,
      itemId: String(current.id),
      expectedRevision: 0,
      force: false,
    })).rejects.toMatchObject({ code: "model_drift" });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("consumes an exact dispatch admission once so internal headers cannot replay", async () => {
    const dispatching = row({
      state: "dispatching",
      lifecycle_revision: 1,
      progress_label: "Entering governed execution",
    });
    const admitted = {
      ...dispatching,
      lifecycle_revision: 2,
      progress_label: "Governed execution admitted",
    };
    mocks.sql
      .mockResolvedValueOnce([dispatching])
      .mockResolvedValueOnce([admitted])
      .mockResolvedValueOnce([]);
    const request = {
      message: "Queued prompt",
      mode: "orchestrate",
      strategy: "direct",
      agentId: "atlas",
      threadId: undefined,
      missionId: undefined,
      projectId: undefined,
      computerUseTarget: undefined,
    };

    await expect(validatePromptQueueDispatch({
      itemId: String(dispatching.id),
      dispatchToken: "dispatch-secret",
      tenantId,
      ownerActorId: actorId,
      sessionId: authority.sessionId,
      request,
    })).resolves.toMatchObject({ lifecycleRevision: 2 });
    await expect(validatePromptQueueDispatch({
      itemId: String(dispatching.id),
      dispatchToken: "dispatch-secret",
      tenantId,
      ownerActorId: actorId,
      sessionId: authority.sessionId,
      request,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.sql.mock.calls.filter(([parts]) =>
      (parts as TemplateStringsArray).join("?").includes("SET progress_label")))
      .toHaveLength(1);
  });

  it("returns an explicit stale result when a dispatch progress fence no longer matches", async () => {
    mocks.sql.mockResolvedValueOnce([]);

    await expect(recordPromptQueueDispatchProgress({
      itemId: "00000000-0000-4000-8000-000000000000",
      dispatchToken: "dispatch-secret",
      tenantId,
      ownerActorId: actorId,
      terminal: "failed",
      failureCode: "run_failed",
      executionScope: authority.executionScope,
    })).resolves.toEqual({ status: "stale" });
    expect(mocks.appendEvent).not.toHaveBeenCalled();
  });

  it("returns applied only after the progress row and its event are durably staged", async () => {
    const dispatching = row({
      state: "dispatching",
      lifecycle_revision: 2,
      progress_label: "Governed execution admitted",
    });
    const completed = row({
      ...dispatching,
      state: "completed",
      lifecycle_revision: 3,
      progress_label: "Governed run completed",
      run_id: "run-progress",
      result_thread_id: "thread-progress",
      terminal_at: "2026-09-22T10:05:00.000Z",
    });
    mocks.sql
      .mockResolvedValueOnce([dispatching])
      .mockResolvedValueOnce([completed]);

    await expect(recordPromptQueueDispatchProgress({
      itemId: String(dispatching.id),
      dispatchToken: "dispatch-secret",
      tenantId,
      ownerActorId: actorId,
      runId: "run-progress",
      threadId: "thread-progress",
      terminal: "completed",
      progressLabel: "Governed run completed",
      executionScope: authority.executionScope,
    })).resolves.toEqual({ status: "applied" });
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.prompt_queue.item.completed",
      }),
      expect.objectContaining({ sql: mocks.sql }),
    );
  });

  it("refreshes the six-minute lease for every nonterminal progress receipt", async () => {
    const dispatching = row({
      state: "dispatching",
      lifecycle_revision: 2,
      progress_label: "Governed execution admitted",
    });
    const progressed = row({
      ...dispatching,
      lifecycle_revision: 3,
      progress_label: "Governed run accepted",
      run_id: "run-progress-active",
    });
    const before = Date.now();
    mocks.sql
      .mockResolvedValueOnce([dispatching])
      .mockResolvedValueOnce([progressed]);

    await expect(recordPromptQueueDispatchProgress({
      itemId: String(dispatching.id),
      dispatchToken: "dispatch-secret",
      tenantId,
      ownerActorId: actorId,
      runId: "run-progress-active",
      progressLabel: "Governed run accepted",
      executionScope: authority.executionScope,
    })).resolves.toEqual({ status: "applied" });

    const updateCall = mocks.sql.mock.calls[1];
    const updateStatement = updateCall?.[0].join("?");
    expect(updateStatement).toContain(
      "WHEN ? IS NULL THEN ?\n            ELSE NULL",
    );
    const leaseValue = updateCall?.slice(1).find((value) =>
      typeof value === "string" &&
      Date.parse(value) >= before + 5 * 60_000
    );
    expect(leaseValue).toEqual(expect.any(String));
  });

  it("inspects exact receipts and refuses retries across conflicting coordinates", async () => {
    const dispatchToken = "dispatch-secret";
    mocks.sql.mockResolvedValueOnce([{
      state: "completed",
      dispatch_token_sha256: null,
      run_id: "run-inspected",
      result_thread_id: "thread-inspected",
      progress_label: "Governed run completed",
      failure_code: null,
    }]);
    await expect(inspectPromptQueueDispatchReceipt({
      itemId: "00000000-0000-4000-8000-000000000000",
      dispatchToken,
      tenantId,
      ownerActorId: actorId,
      runId: "run-inspected",
      threadId: "thread-inspected",
      progressLabel: "Governed run completed",
      terminal: "completed",
    })).resolves.toEqual({ status: "applied" });

    mocks.sql.mockResolvedValueOnce([{
      state: "dispatching",
      dispatch_token_sha256: sha256(dispatchToken),
      run_id: "run-other",
      result_thread_id: "thread-other",
      progress_label: "Governed run accepted",
      failure_code: null,
    }]);
    await expect(inspectPromptQueueDispatchReceipt({
      itemId: "00000000-0000-4000-8000-000000000000",
      dispatchToken,
      tenantId,
      ownerActorId: actorId,
      runId: "run-requested",
      threadId: "thread-requested",
      terminal: "completed",
    })).resolves.toEqual({ status: "stale" });

    mocks.sql.mockResolvedValueOnce([{
      state: "dispatching",
      dispatch_token_sha256: sha256(dispatchToken),
      run_id: null,
      result_thread_id: null,
      progress_label: "Governed execution admitted",
      failure_code: null,
    }]);
    await expect(inspectPromptQueueDispatchReceipt({
      itemId: "00000000-0000-4000-8000-000000000000",
      dispatchToken,
      tenantId,
      ownerActorId: actorId,
      runId: "run-requested",
      threadId: "thread-requested",
    })).resolves.toEqual({ status: "retryable" });
  });

  it("reconciles expired no-run and accepted-run leases without replay", async () => {
    const noRun = row({
      id: "00000000-0000-4000-8000-000000000011",
      state: "dispatching",
      lifecycle_revision: 2,
      progress_label: "Governed execution admitted",
    });
    const accepted = row({
      id: "00000000-0000-4000-8000-000000000012",
      state: "dispatching",
      lifecycle_revision: 5,
      progress_label: "Running",
      run_id: "run-accepted",
    });
    const failed = row({
      ...noRun,
      state: "failed",
      lifecycle_revision: 3,
      failure_code: "dispatch_lease_expired_before_acceptance",
      terminal_at: "2026-09-22T10:05:00.000Z",
    });
    const completed = row({
      ...accepted,
      state: "completed",
      lifecycle_revision: 6,
      terminal_at: "2026-09-22T10:05:00.000Z",
    });
    mocks.sql
      .mockResolvedValueOnce([noRun, accepted])
      .mockResolvedValueOnce([failed])
      .mockResolvedValueOnce([{
        status: "completed",
        thread_id: "thread-accepted",
      }])
      .mockResolvedValueOnce([completed]);

    await expect(reconcileExpiredPromptQueueDispatches(authority)).resolves.toBe(2);
    expect(mocks.appendEvent).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "command.prompt_queue.item.failed",
      "command.prompt_queue.item.completed",
    ]);
    const runStatusLookup = mocks.sql.mock.calls[2]?.[0].join("?");
    expect(runStatusLookup).toContain("SELECT status, thread_id");
    expect(runStatusLookup).not.toContain("updated_at");
  });

  it("settles an accepted run that is waiting for approval", async () => {
    const accepted = row({
      id: "00000000-0000-4000-8000-000000000013",
      state: "dispatching",
      lifecycle_revision: 5,
      progress_label: "Governed run accepted",
      run_id: "run-active",
      dispatched_at: new Date().toISOString(),
    });
    const completed = row({
      ...accepted,
      state: "completed",
      lifecycle_revision: 6,
      progress_label: "Accepted and waiting for approval",
      result_thread_id: "thread-active",
    });
    mocks.sql
      .mockResolvedValueOnce([accepted])
      .mockResolvedValueOnce([{
        status: "waiting_approval",
        thread_id: "thread-active",
      }])
      .mockResolvedValueOnce([completed]);

    await expect(reconcileExpiredPromptQueueDispatches(authority)).resolves.toBe(1);
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.prompt_queue.item.completed",
        payload: expect.objectContaining({ state: "completed" }),
      }),
      expect.objectContaining({ sql: mocks.sql }),
    );
    expect(mocks.appendEvent.mock.calls[0]?.[0]?.type).toBe(
      "command.prompt_queue.item.completed",
    );
    expect(mocks.sql.mock.calls[2]?.[0].join("?")).toContain("SET state = ?");
  });

  it("extends a recent active run but fails it after the finite recovery bound", async () => {
    const recent = row({
      id: "00000000-0000-4000-8000-000000000014",
      state: "dispatching",
      lifecycle_revision: 5,
      run_id: "run-recent",
      dispatched_at: new Date().toISOString(),
    });
    const refreshed = row({
      ...recent,
      lifecycle_revision: 6,
      progress_label: "Governed run is still active",
    });
    mocks.sql
      .mockResolvedValueOnce([recent])
      .mockResolvedValueOnce([{ status: "running", thread_id: "thread-recent" }])
      .mockResolvedValueOnce([refreshed]);

    await expect(reconcileExpiredPromptQueueDispatches(authority)).resolves.toBe(1);
    expect(mocks.appendEvent.mock.calls[0]?.[0]?.type).toBe(
      "command.prompt_queue.item.progressed",
    );

    mocks.sql.mockReset();
    mocks.appendEvent.mockReset().mockResolvedValue(undefined);
    const old = row({
      id: "00000000-0000-4000-8000-000000000015",
      state: "dispatching",
      lifecycle_revision: 7,
      run_id: "run-old",
      dispatched_at: new Date(Date.now() - 16 * 60_000).toISOString(),
    });
    const failed = row({
      ...old,
      state: "failed",
      lifecycle_revision: 8,
      failure_code: "run_outcome_unconfirmed",
    });
    mocks.sql
      .mockResolvedValueOnce([old])
      .mockResolvedValueOnce([{ status: "running", thread_id: "thread-old" }])
      .mockResolvedValueOnce([failed]);

    await expect(reconcileExpiredPromptQueueDispatches(authority)).resolves.toBe(1);
    expect(mocks.appendEvent.mock.calls[0]?.[0]?.type).toBe(
      "command.prompt_queue.item.failed",
    );
    expect(mocks.sql.mock.calls[2]?.slice(1)).toContain(
      "run_outcome_unconfirmed",
    );
  });
});

function createRequest(clientCorrelationId: string) {
  return {
    clientCorrelationId,
    prompt: "Queued prompt",
    mode: "orchestrate" as const,
    strategy: "direct" as const,
    agentId: "atlas",
    target: {
      threadId: null,
      missionId: null,
      projectId: null,
      executionTarget: "asael" as const,
    },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  const prompt = typeof overrides.prompt === "string"
    ? overrides.prompt
    : "Queued prompt";
  const state = String(overrides.state || "queued");
  const promptSha256 = String(
    overrides.prompt_sha256 || sha256(prompt),
  );
  return {
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000000",
    tenant_id: tenantId,
    owner_actor_id: actorId,
    client_correlation_id: "correlation-one",
    origin_session_id: "session-queue",
    last_modified_session_id: "session-queue",
    sealed_prompt: { value: { prompt }, binding: "test" },
    prompt_sha256: promptSha256,
    prompt_characters: prompt.length,
    mode: "orchestrate",
    strategy: "direct",
    target: {
      threadId: null,
      missionId: null,
      projectId: null,
      executionTarget: "asael",
    },
    target_sha256: "c".repeat(64),
    agent_pin: agentPin(),
    model_pin: modelPin(),
    state,
    position_key: 1024,
    lifecycle_revision: 0,
    run_id: null,
    result_thread_id: null,
    progress_label: null,
    failure_code: null,
    created_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:00:00.000Z",
    dispatched_at: state === "dispatching"
      ? "2026-09-22T10:01:00.000Z"
      : null,
    terminal_at: null,
    queue_grants_authority: false,
    ...overrides,
  };
}

function identity() {
  return {
    definition: {
      logicalAgentId: "atlas",
      definitionId: "definition:atlas",
      definitionVersion: 1,
      definitionVersionId: "definition:atlas:v1",
      definitionSha256: "d".repeat(64),
      modelPolicy: {},
    },
    principal: {
      principalId: "principal:atlas",
      principalGeneration: 1,
      principalVersionId: "principal:atlas:v1",
      principalSha256: "e".repeat(64),
    },
  };
}

function agentPin() {
  const value = identity();
  return {
    logicalAgentId: value.definition.logicalAgentId,
    definitionId: value.definition.definitionId,
    definitionVersion: value.definition.definitionVersion,
    definitionVersionId: value.definition.definitionVersionId,
    definitionSha256: value.definition.definitionSha256,
    principalId: value.principal.principalId,
    principalGeneration: value.principal.principalGeneration,
    principalVersionId: value.principal.principalVersionId,
    principalSha256: value.principal.principalSha256,
  };
}

function modelPin(overrides: {
  source?: "tenant_assignment" | "deployment_environment";
  assignmentId?: string | null;
  assignmentRevision?: number | null;
  assignmentConfigurationSha256?: string | null;
} = {}) {
  const base = {
    providerId: "openai" as const,
    modelId: "gpt-test",
    tier: "reasoning" as const,
    assignmentId: overrides.assignmentId ?? null,
    assignmentRevision: overrides.assignmentRevision ?? null,
    assignmentConfigurationSha256:
      overrides.assignmentConfigurationSha256 ?? null,
  };
  return {
    ...base,
    routingPolicySha256: runtimeModelRoutingPolicySha256({
      scope: "agent:atlas:standard",
      source: overrides.source || "deployment_environment",
      ...base,
    }),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
