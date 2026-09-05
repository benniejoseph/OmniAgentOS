import { describe, expect, it, vi } from "vitest";
import {
  DatabaseMemoryAccessScopeError,
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  setTransactionLocalDatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { createExecutionScope } from "@/lib/security/execution-scope";

const validScope = {
  version: 1,
  tenantId: "tenant:one",
  initiatingActorId: "actor:one",
  executingPrincipalType: "user",
  executingPrincipalId: "actor:one",
  workspaceId: null,
  projectId: "project:one",
  missionId: null,
  contextGrantIds: ["context:a", "context:b"],
  capabilityGrantIds: [],
  purposeId: "memory:read",
  purpose: "Read project memory",
} as const;

describe("database memory access scope", () => {
  it("parses, copies, freezes, and deterministically serializes the exact shape", () => {
    const reordered = {
      purpose: validScope.purpose,
      purposeId: validScope.purposeId,
      capabilityGrantIds: [...validScope.capabilityGrantIds],
      contextGrantIds: [...validScope.contextGrantIds],
      missionId: validScope.missionId,
      projectId: validScope.projectId,
      workspaceId: validScope.workspaceId,
      executingPrincipalId: validScope.executingPrincipalId,
      executingPrincipalType: validScope.executingPrincipalType,
      initiatingActorId: validScope.initiatingActorId,
      tenantId: validScope.tenantId,
      version: validScope.version,
    };

    const parsed = parseDatabaseMemoryAccessScope(reordered);

    expect(parsed).toEqual(validScope);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.contextGrantIds)).toBe(true);
    expect(serializeDatabaseMemoryAccessScope(reordered)).toBe(
      JSON.stringify(validScope),
    );
  });

  it("rejects extra fields, nullable principals, user mismatch, and bad grant order", () => {
    expect(() =>
      parseDatabaseMemoryAccessScope({ ...validScope, extra: true }),
    ).toThrow(DatabaseMemoryAccessScopeError);
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        executingPrincipalId: null,
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        executingPrincipalId: "actor:other",
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        contextGrantIds: ["context:b", "context:a"],
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        contextGrantIds: ["context:a", "context:a"],
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
  });

  it("matches PostgreSQL character length and C ordering at their edges", () => {
    expect(
      parseDatabaseMemoryAccessScope({
        ...validScope,
        contextGrantIds: ["context:A", "context:a"],
        purpose: "😀".repeat(500),
      }),
    ).toMatchObject({ contextGrantIds: ["context:A", "context:a"] });
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        purpose: "😀".repeat(501),
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
    expect(() =>
      parseDatabaseMemoryAccessScope({
        ...validScope,
        contextGrantIds: ["context:a", "context:A"],
      }),
    ).toThrow(DatabaseMemoryAccessScopeError);
  });

  it("accepts an actor-bound system principal without granting maintenance scope", () => {
    expect(
      parseDatabaseMemoryAccessScope({
        ...validScope,
        executingPrincipalType: "system",
        executingPrincipalId: "service:memory_consolidator",
      }),
    ).toMatchObject({
      executingPrincipalType: "system",
      executingPrincipalId: "service:memory_consolidator",
    });
  });

  it("requires a separate purpose ID when adapting attribution", () => {
    const executionScope = createExecutionScope({
      tenantId: "tenant:one",
      initiatingActorId: "actor:one",
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:asael",
      projectId: "project:one",
      correlationId: "request:one",
      contextGrantIds: ["context:b", "context:a"],
      capabilityGrantIds: [],
      purpose: "This text is not an authorization ID",
    });

    expect(
      databaseMemoryAccessScopeFromExecutionScope(executionScope, {
        purposeId: "memory:read",
        auditPurpose: null,
      }),
    ).toMatchObject({
      purposeId: "memory:read",
      purpose: null,
      contextGrantIds: ["context:a", "context:b"],
    });
  });

  it("requires the existing callback transaction before issuing SQL", async () => {
    const sql = Object.assign(vi.fn(), { transactionScoped: false });

    await expect(
      setTransactionLocalDatabaseMemoryAccessScope(sql, validScope),
    ).rejects.toThrow("existing transaction callback");
    expect(sql).not.toHaveBeenCalled();
  });

  it("sets once and verifies the database-returned envelope", async () => {
    let serialized = "";
    let callCount = 0;
    const sql = Object.assign(
      vi.fn(async (
        _strings: TemplateStringsArray,
        ...parameters: unknown[]
      ) => {
        callCount += 1;
        if (callCount === 1) {
          expect(parameters[0]).toEqual(validScope);
          serialized = String(parameters[2]);
          return [{ applied_scope: parameters[2] }];
        }
        return [{ memory_access_scope: JSON.parse(serialized) }];
      }),
      { transactionScoped: true },
    );

    await expect(
      setTransactionLocalDatabaseMemoryAccessScope(sql, validScope),
    ).resolves.toEqual(validScope);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("does not run postflight when the guarded database preflight refuses", async () => {
    let guardedStatement = "";
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        guardedStatement = strings.join("?");
        return [{ applied_scope: null }];
      }),
      { transactionScoped: true },
    );

    await expect(
      setTransactionLocalDatabaseMemoryAccessScope(sql, validScope),
    ).rejects.toThrow("preflight was not authorized");
    expect(sql).toHaveBeenCalledOnce();
    expect(guardedStatement).toContain("omni_memory_access_scope_v1_is_valid");
    expect(guardedStatement).toContain("current_setting('omni.tenant_id'");
    expect(guardedStatement).toContain("current_setting('omni.system_scope'");
    expect(guardedStatement).toContain(
      "current_setting('omni.memory_access_scope_v1'",
    );
    expect(guardedStatement).toContain("THEN set_config(");
  });

  it("clears a successful write when database postflight does not match", async () => {
    let serialized = "";
    let callCount = 0;
    const sql = Object.assign(
      vi.fn(async (
        _strings: TemplateStringsArray,
        ...parameters: unknown[]
      ) => {
        callCount += 1;
        if (callCount === 1) {
          expect(parameters[0]).toEqual(validScope);
          serialized = String(parameters[2]);
          return [{ applied_scope: parameters[2] }];
        }
        if (callCount === 2) {
          return [{
            memory_access_scope: {
              ...JSON.parse(serialized),
              purposeId: "memory:other",
            },
          }];
        }
        return [{ set_config: "" }];
      }),
      { transactionScoped: true },
    );

    await expect(
      setTransactionLocalDatabaseMemoryAccessScope(sql, validScope),
    ).rejects.toThrow("postflight did not match");
    expect(sql).toHaveBeenCalledTimes(3);
  });
});
