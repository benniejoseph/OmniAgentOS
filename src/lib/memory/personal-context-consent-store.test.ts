import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  hasDatabaseUrl: vi.fn(() => true),
  ensureDatabaseSchema: vi.fn(async () => undefined),
  runWithDatabaseActorScope: vi.fn(
    async (_tenantId: string, _actorIds: readonly string[], operation: () => unknown) =>
      operation(),
  ),
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
}));
const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event:1" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: databaseMocks.ensureDatabaseSchema,
  getSql: () => databaseMocks.sql,
  hasDatabaseUrl: databaseMocks.hasDatabaseUrl,
  runWithDatabaseActorScope: databaseMocks.runWithDatabaseActorScope,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  PERSONAL_CONTEXT_NOTICE_SHA256,
  type PersonalContextConsentAuthorityV1,
} from "@/lib/memory/personal-context-consent";
import {
  PERSONAL_CONTEXT_CONSENT_EVENT_TYPES,
  PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
  PersonalContextConsentError,
  activatePersonalContextConsent,
  getPersonalContextConsentStatus,
  requireActivePersonalContextConsent,
  revokePersonalContextConsent,
} from "@/lib/memory/personal-context-consent-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const actorBinding = Object.freeze({
  version: 1 as const,
  kind: "auth_user" as const,
  authUserId: "11111111-1111-4111-8111-111111111111",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  legacyOwnerActorIds: Object.freeze(["owner@example.test"]),
  readableOwnerActorIds: Object.freeze([
    "actor:11111111-1111-4111-8111-111111111111",
    "owner@example.test",
  ]),
});
const executionScope = createExecutionScope({
  tenantId: "tenant:test",
  initiatingActorId: actorBinding.canonicalActorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorBinding.canonicalActorId,
  correlationId: "request:consent",
  purpose: PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
});
const activeRow = Object.freeze({
  schema_version: 1,
  tenant_id: "tenant:test",
  actor_id: actorBinding.canonicalActorId,
  consent_generation: 1,
  contract_id: "personal-context-consent:1",
  notice_contract_id: "notice:personal-context-automatic",
  notice_contract_version: 1,
  notice_sha256: PERSONAL_CONTEXT_NOTICE_SHA256,
  state: "active",
  lifecycle_revision: 1,
  activated_by_actor_id: actorBinding.canonicalActorId,
  revoked_by_actor_id: null,
  activated_at: new Date("2026-09-08T01:00:00.000Z"),
  revoked_at: null,
});

function sqlText(strings: TemplateStringsArray) {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

describe("personal context consent store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.hasDatabaseUrl.mockReturnValue(true);
    databaseMocks.runWithDatabaseActorScope.mockImplementation(
      async (_tenantId, _actorIds, operation) => operation(),
    );
    databaseMocks.sql.transaction.mockImplementation(async (operation) =>
      operation(databaseMocks.sql)
    );
  });

  it("fails closed to inactive without durable storage", async () => {
    databaseMocks.hasDatabaseUrl.mockReturnValue(false);

    await expect(getPersonalContextConsentStatus({
      tenantId: "tenant:test",
      actorBinding,
    })).resolves.toMatchObject({ state: "inactive", authority: null });
    await expect(requireActivePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
    })).rejects.toMatchObject({ code: "postgres_required" });
  });

  it("activates exact self-consent and appends metadata in the same transaction", async () => {
    databaseMocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = sqlText(strings);
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("state = 'active'")) return [];
      if (query.includes("next_generation")) return [{ next_generation: 1 }];
      if (query.includes("INSERT INTO omni_personal_context_consents")) {
        return [activeRow];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const status = await activatePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      executionScope,
      noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
    });

    expect(status.state).toBe("active");
    expect(status.authority?.consentGeneration).toBe(1);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.activated,
        executionScope,
        payload: expect.objectContaining({
          actorId: actorBinding.canonicalActorId,
          noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
          authoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
      { sql: databaseMocks.sql },
    );
    expect(JSON.stringify(eventMocks.appendScopedDomainEvent.mock.calls[0])).not
      .toContain("Allow Asael");
  });

  it("revalidates the exact active digest", async () => {
    databaseMocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (sqlText(strings).includes("state = 'active'")) return [activeRow];
      throw new Error("Unexpected SQL");
    });
    const status = await getPersonalContextConsentStatus({
      tenantId: "tenant:test",
      actorBinding,
    });
    const authority = status.authority as PersonalContextConsentAuthorityV1;

    await expect(requireActivePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      expectedAuthoritySha256: authority.authoritySha256,
    })).resolves.toEqual(authority);
    await expect(requireActivePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      expectedAuthoritySha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "inactive" });
  });

  it("revokes only the current exact generation and records the transition", async () => {
    databaseMocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = sqlText(strings);
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("UPDATE omni_personal_context_consents")) {
        return [{ ...activeRow, state: "revoked", lifecycle_revision: 2 }];
      }
      if (query.includes("state = 'active'")) return [activeRow];
      throw new Error(`Unexpected SQL: ${query}`);
    });

    await expect(revokePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      executionScope,
    })).resolves.toMatchObject({ state: "inactive", authority: null });
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.revoked,
        payload: expect.objectContaining({ lifecycleRevision: 2 }),
      }),
      { sql: databaseMocks.sql },
    );
  });

  it("rejects stale notices and non-user mutation authority before database work", async () => {
    await expect(activatePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      executionScope,
      noticeSha256: "0".repeat(64),
    })).rejects.toBeInstanceOf(PersonalContextConsentError);

    const agentScope = createExecutionScope({
      tenantId: "tenant:test",
      initiatingActorId: actorBinding.canonicalActorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:test",
      correlationId: "request:consent",
      purpose: PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
    });
    await expect(revokePersonalContextConsent({
      tenantId: "tenant:test",
      actorBinding,
      executionScope: agentScope,
    })).rejects.toMatchObject({ code: "invalid_authority" });
    expect(databaseMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
  });
});
