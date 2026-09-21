import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    membershipRows: [{
      canonical_actor_id: "actor:11111111-1111-4111-8111-111111111111",
      auth_user_id: "11111111-1111-4111-8111-111111111111",
      membership_role: "admin",
    }] as Record<string, unknown>[],
  };
  const statements: string[] = [];
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    const statement = parts.join("?");
    statements.push(statement);
    if (
      statement.includes("SELECT canonical_actor_id, auth_user_id, membership_role") &&
      statement.includes("omni_resolve_moltbook_owner_membership_v1")
    ) {
      return [...state.membershipRows];
    }
    if (statement.includes("SELECT enrollment.*, authority.id AS exact_authority_id")) {
      return [];
    }
    if (
      statement.includes("SELECT enrollment.*") &&
      statement.includes("ORDER BY enrollment.enrollment_version DESC")
    ) {
      return [enrollmentRow()];
    }
    if (
      statement.includes("SELECT * FROM omni_moltbook_authority_versions") &&
      statement.includes("authority_version =")
    ) {
      return [authorityRow()];
    }
    if (statement.includes("AS connection_ready") && statement.includes("AS executable")) {
      return [{ connection_ready: true, executable: true }];
    }
    if (statement.includes("count(*) FILTER (WHERE action_kind = 'post')")) {
      return [{
        posts: 0,
        comments: 0,
        votes: 0,
        follows: 0,
        subscriptions: 0,
        earliest_claimed_at: null,
      }];
    }
    return [];
  });
  const transaction = vi.fn(
    async (operation: (transactionSql: typeof sql) => unknown) => operation(sql),
  );
  return {
    actorScope: vi.fn(),
    ensureDatabaseSchema: vi.fn(async () => undefined),
    sql: Object.assign(sql, { transaction }),
    state,
    statements,
    systemScope: vi.fn(),
    transaction,
  };
});

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
  runWithDatabaseActorScope: mocks.actorScope,
  runWithDatabaseSystemScope: mocks.systemScope,
}));

import {
  claimDueMoltbookAutonomyCycle,
  listMoltbookAutonomyProjection,
  MoltbookAutonomyStoreError,
} from "@/lib/moltbook/autonomy-store";

const tenantId = "tenant-one";
const ownerActorId = "owner@example.test";
const canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";
const agentId = "agent-moltbook";

describe("Moltbook canonical owner actor scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statements.splice(0);
    mocks.state.membershipRows = [{
      canonical_actor_id: canonicalActorId,
      auth_user_id: "11111111-1111-4111-8111-111111111111",
      membership_role: "admin",
    }];
    mocks.actorScope.mockImplementation(
      async (
        _scopeTenantId: string,
        _actorIds: readonly string[],
        operation: () => unknown,
      ) => operation(),
    );
    mocks.systemScope.mockImplementation(
      async (_reason: string, operation: () => unknown) => operation(),
    );
  });

  it("resolves a legacy owner before projecting the canonical Agent boundary", async () => {
    await expect(listMoltbookAutonomyProjection({
      owner: { tenantId, actorId: ownerActorId },
      agentId,
    })).resolves.toMatchObject({
      executable: true,
      enrollment: { status: "enabled" },
    });

    expect(mocks.actorScope.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [tenantId, [ownerActorId]],
      [tenantId, [ownerActorId, canonicalActorId]],
    ]);
    expect(mocks.statements[0]).toContain(
      "public.omni_resolve_moltbook_owner_membership_v1",
    );
    expect(mocks.statements.join("\n")).not.toContain(
      "omni_auth_user_actor_identifiers",
    );
  });

  it("fails closed before projection when active owner membership is unavailable", async () => {
    mocks.state.membershipRows = [];

    const projection = listMoltbookAutonomyProjection({
      owner: { tenantId, actorId: ownerActorId },
      agentId,
    });
    await expect(projection).rejects.toBeInstanceOf(MoltbookAutonomyStoreError);
    await expect(projection).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.actorScope).toHaveBeenCalledTimes(1);
    expect(mocks.statements).toHaveLength(1);
  });

  it("fails closed when owner membership resolution is ambiguous", async () => {
    mocks.state.membershipRows = [
      {
        canonical_actor_id: canonicalActorId,
        auth_user_id: "11111111-1111-4111-8111-111111111111",
        membership_role: "admin",
      },
      {
        canonical_actor_id: "actor:22222222-2222-4222-8222-222222222222",
        auth_user_id: "22222222-2222-4222-8222-222222222222",
        membership_role: "operator",
      },
    ];

    await expect(listMoltbookAutonomyProjection({
      owner: { tenantId, actorId: ownerActorId },
      agentId,
    })).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.actorScope).toHaveBeenCalledTimes(1);
  });

  it("expands owner-requested cycle claims to the same canonical actor scope", async () => {
    await expect(claimDueMoltbookAutonomyCycle({
      tenantId,
      leaseOwner: "owner-request-canary",
      exactOwner: { tenantId, actorId: ownerActorId },
      agentId,
      forceDue: true,
    })).resolves.toBeNull();

    expect(mocks.actorScope.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [tenantId, [ownerActorId]],
      [tenantId, [ownerActorId, canonicalActorId]],
    ]);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.systemScope).not.toHaveBeenCalled();
  });

  it("keeps scheduled claims exclusively on audited system scope", async () => {
    await expect(claimDueMoltbookAutonomyCycle({
      tenantId,
      leaseOwner: "scheduled-canary",
    })).resolves.toBeNull();

    expect(mocks.actorScope).not.toHaveBeenCalled();
    expect(mocks.systemScope).toHaveBeenCalledWith(
      `claim due Moltbook autonomy cycle for tenant ${tenantId}`,
      expect.any(Function),
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

function enrollmentRow() {
  return {
    id: "moltbook_enrollment_" + "a".repeat(48),
    connection_id: "moltbook_connection_" + "b".repeat(48),
    agent_id: agentId,
    enrollment_version: 1,
    authority_version: 2,
    status: "enabled",
    charter_sha256: "c".repeat(64),
    cycle_interval_seconds: 14_400,
    cycle_post_limit: 1,
    cycle_comment_limit: 2,
    cycle_vote_limit: 4,
    cycle_follow_limit: 1,
    cycle_subscribe_limit: 1,
    daily_post_limit: 1,
    daily_comment_limit: 6,
    daily_vote_limit: 12,
    daily_follow_limit: 2,
    daily_subscribe_limit: 2,
    next_cycle_at: "2026-09-21T18:00:00.000Z",
    enabled_at: "2026-09-21T14:00:00.000Z",
  };
}

function authorityRow() {
  return {
    id: "moltbook_authority_" + "d".repeat(48),
    connection_id: "moltbook_connection_" + "b".repeat(48),
    agent_id: agentId,
    authority_version: 2,
    principal_id: "principal-moltbook",
    principal_generation: 2,
    principal_sha256: "e".repeat(64),
    definition_version: 1,
    definition_sha256: "f".repeat(64),
    policy_boundary_sha256: "1".repeat(64),
    change_reason: "agent_rebind",
    change_request_sha256: "2".repeat(64),
    created_at: "2026-09-21T14:00:00.000Z",
  };
}
