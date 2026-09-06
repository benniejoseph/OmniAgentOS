import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => true),
  appendScopedDomainEvent: vi.fn(async (input) => ({ id: input.id })),
  resolveCustomAgentIdentityWithSql: vi.fn(),
  rotateCustomAgentGrantAuthorityWithSql: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveCustomAgentIdentityWithSql: mocks.resolveCustomAgentIdentityWithSql,
  rotateCustomAgentGrantAuthorityWithSql:
    mocks.rotateCustomAgentGrantAuthorityWithSql,
}));

import {
  createAgentMemoryGrant,
  listAgentMemoryGrants,
  revokeAgentMemoryGrant,
} from "@/lib/memory/agent-grant-store";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const owner = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  canonicalActorId: actorId,
};
type TestPrincipal = ReturnType<typeof principal>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasDatabaseUrl.mockReturnValue(true);
});

describe("P7.4 Agent memory grant store", () => {
  it("creates and activates a grant while pinning the new principal generation", async () => {
    const database = fakeDatabase();
    mocks.getSql.mockReturnValue(database.sql);
    mocks.resolveCustomAgentIdentityWithSql.mockResolvedValue(identity(1, []));
    mocks.rotateCustomAgentGrantAuthorityWithSql.mockImplementation(
      async (input: {
        onPrincipalHeld?: (value: TestPrincipal) => Promise<void>;
      }) => {
        const next = principal(2, [database.createdGrantId]);
        await input.onPrincipalHeld?.(next);
        return next;
      },
    );

    const result = await createAgentMemoryGrant("agent-one", {
      schemaVersion: 1,
      grantKind: "context",
      purposeId: "memory.retrieve.v1",
      target: {
        visibility: "agent_private",
        resourceIds: ["memory:one"],
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      maxItems: 12,
      maxBytes: 24_000,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }, owner);

    expect(result.record).toMatchObject({
      grantKind: "context",
      state: "active",
      granteeId: "agent:agent-one",
      granteePrincipalGeneration: 2,
      target: {
        visibility: "agent_private",
        ownerAgentId: "agent:agent-one",
        ownerAgentPrincipalGeneration: 2,
      },
    });
    expect(mocks.rotateCustomAgentGrantAuthorityWithSql).toHaveBeenCalledWith(
      expect.objectContaining({
        contextGrantIds: [result.record.grantId],
        capabilityGrantIds: [],
      }),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
    expect(mocks.appendScopedDomainEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "memory.access_grant.held" }),
      { sql: database.sql },
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "memory.access_grant.activated" }),
      { sql: database.sql },
    );
  });

  it("lists only grants pinned by the current exact principal", async () => {
    const current = grantRow({ state: "active", generation: 3 });
    const database = fakeDatabase({ currentRows: [current] });
    mocks.getSql.mockReturnValue(database.sql);
    mocks.resolveCustomAgentIdentityWithSql.mockResolvedValue(
      identity(3, [String(current.grant_id)]),
    );

    const result = await listAgentMemoryGrants("agent-one", owner);

    expect(result).toHaveLength(1);
    expect(result[0].record.grantGeneration).toBe(1);
    expect(result[0].explanation).toContain("this Agent's private memory");
    expect(database.statements.some((statement) =>
      /grantee_execution_principal_generation/.test(statement)
    )).toBe(true);
  });

  it("revokes the selected grant and rotates to an empty authority set", async () => {
    const current = grantRow({ state: "active", generation: 1 });
    const database = fakeDatabase({ currentRows: [current] });
    mocks.getSql.mockReturnValue(database.sql);
    mocks.resolveCustomAgentIdentityWithSql.mockResolvedValue(
      identity(1, [String(current.grant_id)]),
    );
    mocks.rotateCustomAgentGrantAuthorityWithSql.mockImplementation(
      async (input: {
        onPrincipalHeld?: (value: TestPrincipal) => Promise<void>;
      }) => {
        const next = principal(2, []);
        await input.onPrincipalHeld?.(next);
        return next;
      },
    );

    await revokeAgentMemoryGrant(
      "agent-one",
      String(current.grant_id),
      owner,
    );

    expect(mocks.rotateCustomAgentGrantAuthorityWithSql).toHaveBeenCalledWith(
      expect.objectContaining({ contextGrantIds: [], capabilityGrantIds: [] }),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledOnce();
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory.access_grant.revoked" }),
      { sql: database.sql },
    );
  });
});

function fakeDatabase(options: { currentRows?: Record<string, unknown>[] } = {}) {
  const statements: string[] = [];
  let createdGrantId = "context:pending";
  let createdRow: Record<string, unknown> | undefined;
  const callable = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = strings.join("?");
      statements.push(text);
      if (/SELECT agent\.\*/.test(text)) return [agentRow()];
      if (/SELECT \*/.test(text) && /omni_tenant_memory_access_grants/.test(text)) {
        return options.currentRows || [];
      }
      if (/SELECT COALESCE\(MAX\(grant_generation\)/.test(text)) {
        return [{ next_generation: 1 }];
      }
      if (/INSERT INTO omni_tenant_memory_access_grants/.test(text)) {
        createdGrantId = String(params.find((value) =>
          typeof value === "string" && value.startsWith("context:")
        ));
        createdRow = grantRow({
          state: "held",
          generation: 2,
          grantId: createdGrantId,
          expiresAt: String(params.find((value) =>
            typeof value === "string" && /^20\d\d-/.test(value)
          )),
        });
        return [createdRow];
      }
      if (/SET state = 'active'/.test(text) && createdRow) {
        createdRow = {
          ...createdRow,
          state: "active",
          lifecycle_revision: 1,
          activated_by_actor_id: actorId,
          activated_at: "2026-09-07T10:00:01.000Z",
          updated_at: "2026-09-07T10:00:01.000Z",
        };
        return [createdRow];
      }
      if (/SET state = 'revoked'/.test(text)) {
        const row = options.currentRows?.[0] || createdRow;
        return row ? [{
          ...row,
          state: "revoked",
          lifecycle_revision: 2,
          revoked_by_actor_id: actorId,
          revoked_at: "2026-09-07T11:00:00.000Z",
          updated_at: "2026-09-07T11:00:00.000Z",
        }] : [];
      }
      return [];
    },
    {
      transaction: vi.fn(async (callback: (sql: unknown) => unknown) =>
        callback(callable)
      ),
    },
  );
  return {
    sql: callable,
    statements,
    get createdGrantId() { return createdGrantId; },
  };
}

function identity(generation: number, contextGrantIds: string[]) {
  return {
    definition: {},
    principal: principal(generation, contextGrantIds),
  };
}

function principal(generation: number, contextGrantIds: string[]) {
  return {
    principalId: "agent:agent-one",
    principalGeneration: generation,
    contextGrantIds,
    capabilityGrantIds: [],
  };
}

function agentRow() {
  return {
    id: "agent-one",
    tenant_id: "tenant-one",
    actor_id: "owner@example.test",
    slug: "agent-one",
    name: "Agent One",
    role: "Researcher",
    description: "Researches.",
    instructions: "Research exact evidence.",
    persona_profile: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    model_policy: "openai_fast",
    autonomy: "governed",
    approval_policy: "risk_based",
    memory_scope: "all",
    skill_ids: [],
    tool_ids: [],
    created_at: "2026-09-07T09:00:00.000Z",
    updated_at: "2026-09-07T09:00:00.000Z",
  };
}

function grantRow(input: {
  state: "held" | "active";
  generation: number;
  grantId?: string;
  expiresAt?: string;
}) {
  const active = input.state === "active";
  return {
    schema_version: 1,
    tenant_id: "tenant-one",
    grant_kind: "context",
    grant_id: input.grantId || "context:grant-one",
    grant_generation: 1,
    grantee_kind: "agent",
    grantee_key: "agent:agent-one",
    grantee_actor_id: null,
    grantee_execution_principal_id: "agent:agent-one",
    grantee_execution_principal_generation: input.generation,
    purpose_id: "memory.retrieve.v1",
    target_visibility: "agent_private",
    owner_actor_id: actorId,
    owner_agent_id: "agent:agent-one",
    owner_agent_principal_generation: input.generation,
    workspace_id: null,
    project_id: null,
    mission_id: null,
    resource_ids: ["memory:one"],
    operation_ids: null,
    max_items: 12,
    max_bytes: 24_000,
    max_invocations: null,
    max_cost_microusd: null,
    max_duration_ms: null,
    not_before: "2026-09-07T10:00:00.000Z",
    expires_at: input.expiresAt || "2099-09-08T10:00:00.000Z",
    state: input.state,
    lifecycle_revision: active ? 1 : 0,
    created_by_actor_id: actorId,
    activated_by_actor_id: active ? actorId : null,
    revoked_by_actor_id: null,
    created_at: "2026-09-07T10:00:00.000Z",
    activated_at: active ? "2026-09-07T10:00:01.000Z" : null,
    revoked_at: null,
    updated_at: active
      ? "2026-09-07T10:00:01.000Z"
      : "2026-09-07T10:00:00.000Z",
  };
}
