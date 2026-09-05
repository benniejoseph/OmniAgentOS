import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseTenantScope: vi.fn(
    async (_tenantId: string, operation: () => unknown) => operation(),
  ),
}));

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => dbMocks);
vi.mock("@/lib/events/store", () => eventMocks);

import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  getCurrentTenantCapabilityRollout,
  isTenantCapabilityRolloutTransitionAllowed,
  registerTenantCapabilityRollout,
  tenantCapabilityRolloutRegisteredEventPayloadSchema,
  tenantCapabilityRolloutSchema,
  tenantCapabilityRolloutTransitionEventPayloadSchema,
  transitionTenantCapabilityRolloutStatus,
  type TenantCapabilityRolloutStatus,
} from "@/lib/rollouts/tenant-capability-rollouts";

const TENANT_ID = "tenant_rollout_test";
const CAPABILITY_ID = "source.drive.canonical";
const ACTOR_ID = "actor_rollout_operator";
const CREATED_AT = "2026-09-04T05:00:00.000Z";
const UPDATED_AT = "2026-09-04T05:00:01.000Z";
const ACTIVATED_AT = "2026-09-04T05:00:02.000Z";
const SUPERSEDED_AT = "2026-09-04T05:00:03.000Z";

type QueryCall = Readonly<{
  kind: "query" | "tag";
  text: string;
  params: readonly unknown[];
}>;

describe("tenant capability rollout contract and store", () => {
  beforeEach(() => {
    dbMocks.ensureDatabaseSchema.mockClear();
    dbMocks.getSql.mockReset();
    dbMocks.hasDatabaseUrl.mockReset();
    dbMocks.hasDatabaseUrl.mockReturnValue(true);
    dbMocks.runWithDatabaseTenantScope.mockClear();
    eventMocks.appendScopedDomainEvent.mockClear();
  });

  it("uses strict metadata-only rollout record and payload contracts", () => {
    const rollout = contractRecord("registered");
    expect(tenantCapabilityRolloutSchema.parse(rollout)).toEqual(rollout);
    expect(tenantCapabilityRolloutSchema.safeParse({
      ...rollout,
      configuration: { raw: "must-not-enter-the-contract" },
    }).success).toBe(false);

    const registrationPayload = {
      schemaVersion: 1 as const,
      capabilityId: CAPABILITY_ID,
      rolloutGeneration: 2,
      engineVersion: "engine_v2",
      contractVersionId: "contract_v2",
      configurationSha256: digest("configuration-v2"),
      mode: "canary" as const,
      status: "registered" as const,
      lifecycleRevision: 0 as const,
      createdByActorId: ACTOR_ID,
      supersededRolloutGeneration: 1,
      supersededRolloutPreviousStatus: "active" as const,
    };
    expect(
      tenantCapabilityRolloutRegisteredEventPayloadSchema.parse(
        registrationPayload,
      ),
    ).toEqual(registrationPayload);
    expect(
      tenantCapabilityRolloutRegisteredEventPayloadSchema.safeParse({
        ...registrationPayload,
        rawConfiguration: "forbidden",
      }).success,
    ).toBe(false);

    const transitionPayload = {
      schemaVersion: 1 as const,
      capabilityId: CAPABILITY_ID,
      rolloutGeneration: 2,
      engineVersion: "engine_v2",
      contractVersionId: "contract_v2",
      configurationSha256: digest("configuration-v2"),
      mode: "canary" as const,
      fromStatus: "registered" as const,
      toStatus: "active" as const,
      lifecycleRevision: 1,
      transitionedByActorId: ACTOR_ID,
      activatedByActorId: ACTOR_ID,
      activatedAt: ACTIVATED_AT,
      supersededAt: null,
    };
    expect(
      tenantCapabilityRolloutTransitionEventPayloadSchema.parse(
        transitionPayload,
      ),
    ).toEqual(transitionPayload);
    expect(
      tenantCapabilityRolloutTransitionEventPayloadSchema.safeParse({
        ...transitionPayload,
        fromStatus: "active",
        toStatus: "superseded",
        lifecycleRevision: 2,
        activatedAt: SUPERSEDED_AT,
        supersededAt: ACTIVATED_AT,
      }).success,
    ).toBe(false);
  });

  it("fails closed without DATABASE_URL and has no file fallback", async () => {
    dbMocks.hasDatabaseUrl.mockReturnValue(false);

    await expect(getCurrentTenantCapabilityRollout({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
    })).rejects.toMatchObject({ code: "postgres_required" });
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.runWithDatabaseTenantScope).not.toHaveBeenCalled();
  });

  it("reads only the current generation under the explicit tenant scope", async () => {
    const { sql, calls } = fakeSql((call) =>
      call.text.includes("status <> 'superseded'")
        ? [storedRow("active", { rollout_generation: "7" })]
        : []
    );
    dbMocks.getSql.mockReturnValue(sql);

    await expect(getCurrentTenantCapabilityRollout({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
    })).resolves.toMatchObject({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
      rolloutGeneration: 7,
      status: "active",
    });
    expect(dbMocks.runWithDatabaseTenantScope).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(calls).toEqual([
      expect.objectContaining({
        kind: "query",
        params: [TENANT_ID, CAPABILITY_ID],
      }),
    ]);
    expect(calls[0]?.text).toContain("LIMIT 2");
  });

  it("requires the exact tenant and initiating actor scope before registration", async () => {
    const { sql, calls } = fakeSql(() => []);
    dbMocks.getSql.mockReturnValue(sql);

    await expect(registerTenantCapabilityRollout({
      ...registrationInput(2),
      executionScope: executionScope("tenant_unrelated"),
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(registerTenantCapabilityRollout({
      ...registrationInput(2),
      executionScope: executionScope(TENANT_ID, null),
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(calls).toHaveLength(0);
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("rejects a generation that is not monotonically higher", async () => {
    const { sql, calls } = fakeSql((call) => {
      if (call.text.includes("SELECT rollout_generation")) {
        return [{ rollout_generation: "5" }];
      }
      return [];
    });
    dbMocks.getSql.mockReturnValue(sql);

    await expect(registerTenantCapabilityRollout(
      registrationInput(5),
    )).rejects.toMatchObject({ code: "generation_conflict" });
    expect(calls.some((call) => call.text.startsWith("INSERT"))).toBe(false);
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("atomically supersedes the current rollout and registers the next one", async () => {
    const prior = storedRow("active", { rollout_generation: "4" });
    const superseded = storedRow("superseded", {
      rollout_generation: "4",
      lifecycle_revision: "2",
      superseded_at: SUPERSEDED_AT,
      updated_at: SUPERSEDED_AT,
    });
    const registered = storedRow("registered", {
      rollout_generation: "5",
      engine_version: "engine_v5",
      contract_version_id: "contract_v5",
      configuration_sha256: digest("configuration-v5"),
      mode: "canary",
      activated_by_actor_id: null,
      activated_at: null,
      created_at: SUPERSEDED_AT,
      updated_at: SUPERSEDED_AT,
    });
    const { sql, calls } = fakeSql((call) => {
      if (call.text.includes("SELECT rollout_generation")) {
        return [{ rollout_generation: "4" }];
      }
      if (
        call.text.startsWith("SELECT schema_version") &&
        call.text.includes("status <> 'superseded'")
      ) {
        return [prior];
      }
      if (call.text.startsWith("UPDATE") && call.text.includes("'superseded'")) {
        return [superseded];
      }
      if (call.text.startsWith("INSERT")) return [registered];
      return [];
    });
    dbMocks.getSql.mockReturnValue(sql);

    await expect(registerTenantCapabilityRollout(
      registrationInput(5),
    )).resolves.toMatchObject({
      rolloutGeneration: 5,
      status: "registered",
      createdByActorId: ACTOR_ID,
    });

    const updateIndex = calls.findIndex((call) => call.text.startsWith("UPDATE"));
    const insertIndex = calls.findIndex((call) => call.text.startsWith("INSERT"));
    expect(updateIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(updateIndex);
    expect(calls[updateIndex]?.params).toEqual([
      TENANT_ID,
      CAPABILITY_ID,
      4,
      "active",
    ]);
    expect(calls[insertIndex]?.params).toEqual([
      1,
      TENANT_ID,
      CAPABILITY_ID,
      5,
      "engine_v5",
      "contract_v5",
      digest("configuration-v5"),
      "canary",
      ACTOR_ID,
    ]);

    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "capability.rollout.status_transitioned",
        payload: expect.objectContaining({
          capabilityId: CAPABILITY_ID,
          rolloutGeneration: 4,
          lifecycleRevision: 2,
          fromStatus: "active",
          toStatus: "superseded",
        }),
      }),
      { sql: expect.any(Function) },
    );
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "capability.rollout.registered",
        payload: expect.objectContaining({
          rolloutGeneration: 5,
          configurationSha256: digest("configuration-v5"),
          supersededRolloutGeneration: 4,
          supersededRolloutPreviousStatus: "active",
        }),
      }),
      { sql: expect.any(Function) },
    );
  });

  it("activates by compare-and-swap and appends the scoped event", async () => {
    const registered = storedRow("registered", {
      rollout_generation: "3",
      activated_by_actor_id: null,
      activated_at: null,
    });
    const active = storedRow("active", {
      rollout_generation: "3",
      lifecycle_revision: "1",
      activated_by_actor_id: ACTOR_ID,
      activated_at: ACTIVATED_AT,
      updated_at: ACTIVATED_AT,
    });
    const { sql, calls } = fakeSql((call) => {
      if (call.text.startsWith("SELECT schema_version")) return [registered];
      if (call.text.startsWith("UPDATE")) return [active];
      return [];
    });
    dbMocks.getSql.mockReturnValue(sql);

    await expect(transitionTenantCapabilityRolloutStatus({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
      expectedRolloutGeneration: 3,
      expectedStatus: "registered",
      nextStatus: "active",
      executionScope: executionScope(),
    })).resolves.toMatchObject({
      rolloutGeneration: 3,
      status: "active",
      activatedByActorId: ACTOR_ID,
      activatedAt: ACTIVATED_AT,
    });

    const update = calls.find((call) => call.text.startsWith("UPDATE"));
    expect(update?.params).toEqual([
      TENANT_ID,
      CAPABILITY_ID,
      3,
      "registered",
      "active",
      ACTOR_ID,
    ]);
    expect(update?.text).toContain("updated_at + INTERVAL '1 microsecond'");
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "capability.rollout.status_transitioned",
        payload: {
          schemaVersion: 1,
          capabilityId: CAPABILITY_ID,
          rolloutGeneration: 3,
          engineVersion: "engine_v2",
          contractVersionId: "contract_v2",
          configurationSha256: digest("configuration-v2"),
          mode: "canary",
          fromStatus: "registered",
          toStatus: "active",
          lifecycleRevision: 1,
          transitionedByActorId: ACTOR_ID,
          activatedByActorId: ACTOR_ID,
          activatedAt: ACTIVATED_AT,
          supersededAt: null,
        },
      }),
      { sql: expect.any(Function) },
    );
  });

  it("rejects stale expected status and illegal transitions without an event", async () => {
    const { sql, calls } = fakeSql((call) =>
      call.text.startsWith("SELECT schema_version")
        ? [storedRow("active", { rollout_generation: "3" })]
        : []
    );
    dbMocks.getSql.mockReturnValue(sql);

    await expect(transitionTenantCapabilityRolloutStatus({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
      expectedRolloutGeneration: 3,
      expectedStatus: "registered",
      nextStatus: "active",
      executionScope: executionScope(),
    })).rejects.toMatchObject({ code: "status_conflict" });
    expect(calls.some((call) => call.text.startsWith("UPDATE"))).toBe(false);

    expect(isTenantCapabilityRolloutTransitionAllowed("active", "paused"))
      .toBe(true);
    expect(isTenantCapabilityRolloutTransitionAllowed("paused", "active"))
      .toBe(true);
    expect(isTenantCapabilityRolloutTransitionAllowed("active", "registered"))
      .toBe(false);
    await expect(transitionTenantCapabilityRolloutStatus({
      tenantId: TENANT_ID,
      capabilityId: CAPABILITY_ID,
      expectedRolloutGeneration: 3,
      expectedStatus: "active",
      nextStatus: "registered",
      executionScope: executionScope(),
    })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});

function registrationInput(rolloutGeneration: number) {
  return {
    tenantId: TENANT_ID,
    capabilityId: CAPABILITY_ID,
    rolloutGeneration,
    engineVersion: `engine_v${rolloutGeneration}`,
    contractVersionId: `contract_v${rolloutGeneration}`,
    configurationSha256: digest(`configuration-v${rolloutGeneration}`),
    mode: "canary" as const,
    executionScope: executionScope(),
  };
}

function executionScope(
  tenantId = TENANT_ID,
  initiatingActorId: string | null = ACTOR_ID,
) {
  return createExecutionScope({
    tenantId,
    initiatingActorId,
    executingPrincipalType: "user",
    executingPrincipalId: initiatingActorId,
    correlationId: "correlation_rollout_test",
    purpose: "Manage a tenant capability rollout.",
  });
}

function contractRecord(status: TenantCapabilityRolloutStatus) {
  const activated = status === "active" || status === "paused";
  const superseded = status === "superseded";
  return {
    schemaVersion: 1 as const,
    tenantId: TENANT_ID,
    capabilityId: CAPABILITY_ID,
    rolloutGeneration: 2,
    engineVersion: "engine_v2",
    contractVersionId: "contract_v2",
    configurationSha256: digest("configuration-v2"),
    mode: "canary" as const,
    status,
    lifecycleRevision: status === "registered" ? 0 : 1,
    createdByActorId: ACTOR_ID,
    ...(activated
      ? { activatedByActorId: ACTOR_ID, activatedAt: ACTIVATED_AT }
      : {}),
    ...(superseded ? { supersededAt: SUPERSEDED_AT } : {}),
    createdAt: CREATED_AT,
    updatedAt: superseded
      ? SUPERSEDED_AT
      : activated
        ? ACTIVATED_AT
        : UPDATED_AT,
  };
}

function storedRow(
  status: TenantCapabilityRolloutStatus,
  overrides: Record<string, unknown> = {},
) {
  const activated = status === "active" || status === "paused" ||
    status === "superseded";
  return {
    schema_version: 1,
    tenant_id: TENANT_ID,
    capability_id: CAPABILITY_ID,
    rollout_generation: "2",
    engine_version: "engine_v2",
    contract_version_id: "contract_v2",
    configuration_sha256: digest("configuration-v2"),
    mode: "canary",
    status,
    lifecycle_revision: status === "registered" ? "0" : "1",
    created_by_actor_id: ACTOR_ID,
    activated_by_actor_id: activated ? ACTOR_ID : null,
    activated_at: activated ? ACTIVATED_AT : null,
    superseded_at: status === "superseded" ? SUPERSEDED_AT : null,
    created_at: CREATED_AT,
    updated_at: status === "superseded"
      ? SUPERSEDED_AT
      : activated
        ? ACTIVATED_AT
        : UPDATED_AT,
    ...overrides,
  };
}

function fakeSql(
  handler: (call: QueryCall) => Record<string, unknown>[],
) {
  const calls: QueryCall[] = [];
  const tagged = () => async (
      strings: TemplateStringsArray,
      ...params: unknown[]
    ) => {
      const call = {
        kind: "tag" as const,
        text: normalizeSql(strings.join("?")),
        params,
      };
      calls.push(call);
      return handler(call);
    };
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const call = {
      kind: "query" as const,
      text: normalizeSql(text),
      params,
    };
    calls.push(call);
    return handler(call);
  });
  const transactionSql = Object.assign(tagged(), {
    query,
    unsafe: vi.fn(),
    transactionScoped: true,
    transaction: vi.fn(),
  });
  const sql = Object.assign(tagged(), {
    query,
    unsafe: vi.fn(),
    transactionScoped: false,
    transaction: vi.fn(async (
      operation: (transactionSql: unknown) => unknown,
    ) => operation(transactionSql)),
  });
  return { sql, calls };
}

function normalizeSql(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function digest(seed: string) {
  return sourceContractSha256({ seed });
}
