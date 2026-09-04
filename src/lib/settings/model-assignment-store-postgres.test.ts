import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const state = { databaseEnabled: true };
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => state.databaseEnabled),
    readJsonFile: vi.fn(),
    rows,
    sql,
    state,
    statements,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
    runWithDatabaseTenantScope: vi.fn(
      async (_tenantId: string, operation: () => Promise<unknown>) => operation(),
    ),
  };
});

vi.mock("@/lib/storage/json", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/json")>();
  return { ...actual, readJsonFile: dbMocks.readJsonFile };
});

vi.mock("@/lib/events/store", () => ({
  appendDomainEventSafely: vi.fn(async () => undefined),
}));

import {
  ModelAssignmentReadConflictError,
  listModelAssignments,
  listModelAssignmentsForRequest,
} from "@/lib/settings/store";

const tenantId = "tenant-a";
const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "assignment-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.state.databaseEnabled = true;
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ assignments: [] });
  dbMocks.sql.mockClear();
});

describe("request-bound model assignments", () => {
  it("projects the request actor and derives readiness and management from physical ownership", async () => {
    dbMocks.rows.push(
      {
        ...assignmentRow(
          "11111111-1111-4111-8111-111111111111",
          canonicalActorId,
          "main_agent",
        ),
        fallback_provider: "google",
        fallback_model_id: "gemini-2.5-pro",
        allow_cross_provider_fallback: true,
        future_secret: "must-not-leak",
      },
      assignmentRow(
        "22222222-2222-4222-8222-222222222222",
        actorId,
        "orchestrator",
      ),
    );

    const records = await listModelAssignmentsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        actorId,
        scope: "main_agent",
        fallbackProvider: "google",
        fallbackModelId: "gemini-2.5-pro",
        allowCrossProviderFallback: true,
        runtimeReadiness: "configuration_only",
        manageable: false,
      }),
      expect.objectContaining({
        actorId,
        scope: "orchestrator",
        runtimeReadiness: "active",
        manageable: true,
      }),
    ]);
    expect(records[0].runtimeNote).toContain("not active");
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).not.toContain("SELECT *");
    expect(dbMocks.statements[0].text).not.toMatch(/\bLIMIT\b/);
    expect(dbMocks.statements[0].text).toMatch(
      /SELECT id, tenant_id, actor_id, scope, provider, model_id,[\s\S]*?FROM omni_model_assignments[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?tenant_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?OR actor_id COLLATE "C" = \$\d+::text COLLATE "C"[\s\S]*?ORDER BY scope COLLATE "C", id COLLATE "C"/,
    );
    expect(dbMocks.statements[0].params).toEqual([
      tenantId,
      canonicalActorId,
      actorId,
      tenantId,
      canonicalActorId,
      actorId,
    ]);
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
  });

  it("uses the exact actor twice when the request binding is absent or malformed", async () => {
    await listModelAssignmentsForRequest({ tenantId, actorId });
    expect(dbMocks.statements[0].params).toEqual([
      tenantId,
      actorId,
      actorId,
      tenantId,
      actorId,
      actorId,
    ]);

    dbMocks.statements.splice(0);
    await listModelAssignmentsForRequest({
      tenantId,
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });
    expect(dbMocks.statements[0].params).toEqual([
      tenantId,
      actorId,
      actorId,
      tenantId,
      actorId,
      actorId,
    ]);
  });

  it("rejects unexpected ownership, duplicate ids, and every duplicate scope", async () => {
    dbMocks.rows.push(assignmentRow(
      "33333333-3333-4333-8333-333333333333",
      "unexpected-owner@example.test",
      "workflow",
    ));
    await expect(requestAssignments()).rejects.toMatchObject({
      name: "ModelAssignmentReadConflictError",
      status: 409,
    });

    dbMocks.rows.splice(0, dbMocks.rows.length, {
      ...assignmentRow(
        "44444444-4444-4444-8444-444444444444",
        actorId,
        "workflow",
      ),
      tenant_id: "tenant-b",
    });
    await expect(requestAssignments()).rejects.toBeInstanceOf(
      ModelAssignmentReadConflictError,
    );

    const duplicateId = "55555555-5555-4555-8555-555555555555";
    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      assignmentRow(duplicateId, canonicalActorId, "memory"),
      assignmentRow(duplicateId, actorId, "vision"),
    );
    await expect(requestAssignments()).rejects.toBeInstanceOf(
      ModelAssignmentReadConflictError,
    );

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      assignmentRow(
        "66666666-6666-4666-8666-666666666666",
        canonicalActorId,
        "audio",
      ),
      assignmentRow(
        "77777777-7777-4777-8777-777777777777",
        actorId,
        "audio",
      ),
    );
    await expect(requestAssignments()).rejects.toBeInstanceOf(
      ModelAssignmentReadConflictError,
    );
  });

  it("fails closed on malformed assignment metadata and inconsistent fallback consent", async () => {
    const valid = assignmentRow(
      "88888888-8888-4888-8888-888888888888",
      actorId,
      "workflow",
    );
    const invalidRows = [
      { ...valid, id: "not-a-uuid" },
      { ...valid, scope: "unknown_scope" },
      { ...valid, provider: "unknown_provider" },
      { ...valid, model_id: "" },
      { ...valid, model_id: "   " },
      { ...valid, model_id: " padded-model " },
      { ...valid, model_id: "m".repeat(241) },
      { ...valid, fallback_provider: "google", fallback_model_id: null },
      { ...valid, fallback_provider: null, fallback_model_id: "gemini-2.5-pro" },
      { ...valid, fallback_provider: "unknown_provider", fallback_model_id: "model" },
      { ...valid, fallback_provider: "google", fallback_model_id: " " },
      { ...valid, fallback_provider: "google", fallback_model_id: "m".repeat(241) },
      {
        ...valid,
        fallback_provider: "google",
        fallback_model_id: "gemini-2.5-pro",
        allow_cross_provider_fallback: false,
      },
      {
        ...valid,
        fallback_provider: "openai",
        fallback_model_id: "gpt-4.1",
        allow_cross_provider_fallback: true,
      },
      { ...valid, allow_cross_provider_fallback: true },
      { ...valid, allow_cross_provider_fallback: "false" },
      { ...valid, runtime_readiness: "active" },
      { ...valid, created_at: null },
      { ...valid, created_at: "not-a-date" },
      { ...valid, updated_at: 42 },
      {
        ...valid,
        created_at: "2026-09-06T10:00:00.000Z",
        updated_at: "2026-09-05T10:00:00.000Z",
      },
    ];

    for (const row of invalidRows) {
      dbMocks.rows.splice(0, dbMocks.rows.length, row);
      await expect(requestAssignments()).rejects.toBeInstanceOf(
        ModelAssignmentReadConflictError,
      );
    }
  });

  it("publishes control-safe display identifiers without rewriting identity", async () => {
    dbMocks.rows.push({
      ...assignmentRow(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        canonicalActorId,
        "workflow",
      ),
      model_id: "model\nname\u061c\u200e\u200f\u202e",
      fallback_provider: "google",
      fallback_model_id: "gemini\u2066pro",
      allow_cross_provider_fallback: true,
    });

    const [record] = await requestAssignments();

    expect(record.modelId).toBe("model\nname\u061c\u200e\u200f\u202e");
    expect(record.displayModelId).toBe("model�name�");
    expect(record.fallbackModelId).toBe("gemini\u2066pro");
    expect(record.displayFallbackModelId).toBe("gemini�pro");
    expect(record.manageable).toBe(false);
  });

  it("keeps file fallback exact-owner and returns an explicit projection", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      assignments: [
        fileAssignment(
          "99999999-9999-4999-8999-999999999999",
          canonicalActorId,
          "workflow",
        ),
        {
          ...fileAssignment(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            actorId,
            "main_agent",
          ),
          futureSecret: "must-not-leak",
        },
      ],
    });

    const records = await listModelAssignmentsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    });

    expect(records).toEqual([
      expect.objectContaining({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tenantId,
        actorId,
        scope: "main_agent",
        runtimeReadiness: "active",
        manageable: true,
      }),
    ]);
    expect(records[0]).not.toHaveProperty("futureSecret");
    expect(JSON.stringify(records)).not.toContain("must-not-leak");
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();

    dbMocks.readJsonFile.mockResolvedValue({
      assignments: [{
        ...fileAssignment(
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          actorId,
          "workflow",
        ),
        provider: "unknown_provider",
      }],
    });
    await expect(listModelAssignmentsForRequest({
      tenantId,
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(ModelAssignmentReadConflictError);

    dbMocks.readJsonFile.mockResolvedValue({
      assignments: [{
        ...fileAssignment(
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          actorId,
          "main_agent",
        ),
        runtimeReadiness: "configuration_only",
      }],
    });
    await expect(listModelAssignmentsForRequest({
      tenantId,
      actorId,
    })).rejects.toBeInstanceOf(ModelAssignmentReadConflictError);
  });

  it("leaves the legacy assignment reader exact-owner", async () => {
    await listModelAssignments({ tenantId, actorId });

    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /SELECT \* FROM omni_model_assignments[\s\S]*?tenant_id = \$\d+ AND actor_id = \$\d+[\s\S]*?ORDER BY scope/,
    );
    expect(dbMocks.statements[0].params).toEqual([tenantId, actorId]);
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
  });
});

function requestAssignments() {
  return listModelAssignmentsForRequest({
    tenantId,
    actorId,
    requestActorBinding: binding,
  });
}

function assignmentRow(
  id: string,
  ownerActorId: string,
  scope: "main_agent" | "orchestrator" | "workflow" | "memory" | "vision" | "audio",
) {
  return {
    id,
    tenant_id: tenantId,
    actor_id: ownerActorId,
    scope,
    provider: "openai",
    model_id: "gpt-5.2",
    fallback_provider: null,
    fallback_model_id: null,
    allow_cross_provider_fallback: false,
    runtime_readiness: "configuration_only",
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-05T10:00:00.000Z",
  };
}

function fileAssignment(
  id: string,
  ownerActorId: string,
  scope: "main_agent" | "workflow",
) {
  return {
    id,
    tenantId,
    actorId: ownerActorId,
    scope,
    provider: "openai",
    modelId: "gpt-5.2",
    fallbackProvider: undefined,
    fallbackModelId: undefined,
    allowCrossProviderFallback: false,
    runtimeReadiness: scope === "main_agent" ? "active" : "configuration_only",
    runtimeNote: "Stored note",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
