import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseTenantScope: vi.fn(),
}));

vi.mock("@/lib/db/client", () => dbMocks);

import {
  MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION,
  MEMORY_AUTHORITY_UNAVAILABLE_CODES,
  MemoryAuthorityDenialCanaryError,
  inspectMemoryAuthorityDenialCanary,
} from "@/lib/memory/authority-resolution-canary";

const TENANT_ID = "tenant:authority-canary";
const AUTH_USER_ID = "11111111-1111-4111-8111-111111111111";
const CANONICAL_ACTOR_ID = `actor:${AUTH_USER_ID}`;
const LEGACY_ACTOR_ID = "authority-owner@example.test";
const PURPOSE_ID = "memory.read.v1";
const MEMBERSHIP_EPOCH = 7;
const CONSENT_GENERATION = 5;
const NOTICE_RECEIPT_ID = "notice-receipt:five";
const NOTICE_CONTRACT_ID = "notice-contract:read-v1";
const NOTICE_CONTRACT_VERSION = 1;
const GRANTED_AT = "2026-09-05T08:00:00.000Z";
const PRESENTED_AT = "2026-09-05T07:59:00.000Z";
const ACKNOWLEDGED_AT = "2026-09-05T08:00:00.000Z";

const ACTOR_BINDING: CanonicalRequestActorBindingV1 = Object.freeze({
  version: 1,
  kind: "auth_user",
  authUserId: AUTH_USER_ID,
  canonicalActorId: CANONICAL_ACTOR_ID,
  legacyOwnerActorIds: Object.freeze([LEGACY_ACTOR_ID]),
  readableOwnerActorIds: Object.freeze([
    CANONICAL_ACTOR_ID,
    LEGACY_ACTOR_ID,
  ]),
});

const ACCESS_SCOPE = Object.freeze({
  version: 1,
  tenantId: TENANT_ID,
  initiatingActorId: CANONICAL_ACTOR_ID,
  executingPrincipalType: "user" as const,
  executingPrincipalId: CANONICAL_ACTOR_ID,
  workspaceId: null,
  projectId: null,
  missionId: null,
  contextGrantIds: Object.freeze([]),
  capabilityGrantIds: Object.freeze([]),
  purposeId: PURPOSE_ID,
  purpose: null,
});

type SqlRow = Record<string, unknown>;

type QueryCall = Readonly<{
  client: "root" | "transaction";
  kind: "query" | "tag" | "unsafe";
  text: string;
  params: readonly unknown[];
}>;

const QUERY_STAGES = [
  "preflight",
  "auth_user",
  "membership",
  "epoch",
  "purpose",
  "entitlement",
  "consent",
  "receipt",
  "notice_contract",
] as const;

type StandardQueryStage = (typeof QUERY_STAGES)[number];
type QueryStage =
  | StandardQueryStage
  | "execution_principal"
  | "workspace"
  | "workspace_membership";
type AuthorityStage = Exclude<StandardQueryStage, "preflight">;
type QueryResponses = Record<StandardQueryStage, SqlRow[]> & {
  execution_principal?: SqlRow[];
  workspace?: SqlRow[];
  workspace_membership?: SqlRow[];
};

const AUTHORITY_STAGES = QUERY_STAGES.slice(1) as readonly AuthorityStage[];

const BASELINE_UNAVAILABLE = [
  "context_grant_authority",
  "capability_grant_authority",
  "operation_policy_authority",
] as const;

const EXPECTED_COLUMNS = {
  auth_user: ["id", "actor_id", "status"],
  membership: ["id", "tenant_id", "user_id", "status"],
  epoch: [
    "schema_version",
    "tenant_id",
    "subject_actor_id",
    "membership_epoch",
    "state",
    "lifecycle_revision",
  ],
  purpose: ["purpose_id", "contract_version", "operation_class"],
  entitlement: [
    "schema_version",
    "tenant_id",
    "purpose_id",
    "entitlement_generation",
    "state",
    "lifecycle_revision",
  ],
  consent: [
    "schema_version",
    "tenant_id",
    "subject_actor_id",
    "purpose_id",
    "consent_generation",
    "membership_epoch",
    "notice_receipt_id",
    "state",
    "lifecycle_revision",
    "granted_by_actor_id",
    "granted_at",
  ],
  receipt: [
    "schema_version",
    "tenant_id",
    "subject_actor_id",
    "purpose_id",
    "consent_generation",
    "membership_epoch",
    "notice_receipt_id",
    "notice_contract_id",
    "notice_contract_version",
    "presented_at",
    "acknowledged_by_actor_id",
    "acknowledged_at",
  ],
  notice_contract: [
    "schema_version",
    "purpose_id",
    "notice_contract_id",
    "notice_contract_version",
    "notice_sha256",
  ],
} satisfies Record<AuthorityStage, readonly string[]>;

const EXPECTED_WHERE = {
  auth_user: "WHERE id = ? AND actor_id = ?",
  membership: "WHERE tenant_id = ? AND user_id = ?",
  epoch:
    "WHERE tenant_id = ? AND subject_actor_id = ? AND state <> 'revoked'",
  purpose: "WHERE purpose_id = ?",
  entitlement:
    "WHERE tenant_id = ? AND purpose_id = ? AND state <> 'revoked'",
  consent:
    "WHERE tenant_id = ? AND subject_actor_id = ? AND purpose_id = ? AND state <> 'revoked'",
  receipt: [
    "WHERE tenant_id = ? AND subject_actor_id = ? AND purpose_id = ?",
    "AND consent_generation = ? AND membership_epoch = ?",
    "AND notice_receipt_id = ?",
  ].join(" "),
  notice_contract:
    "WHERE purpose_id = ? AND notice_contract_id = ? AND notice_contract_version = ?",
} satisfies Record<AuthorityStage, string>;

const EXPECTED_ORDER_BY = {
  auth_user: "ORDER BY id ASC",
  membership: "ORDER BY id ASC",
  epoch: "ORDER BY membership_epoch DESC",
  purpose: "ORDER BY purpose_id ASC, contract_version ASC",
  entitlement: "ORDER BY entitlement_generation DESC",
  consent: "ORDER BY consent_generation DESC",
  receipt: [
    "ORDER BY tenant_id ASC, subject_actor_id ASC, purpose_id ASC,",
    "consent_generation ASC, membership_epoch ASC, notice_receipt_id ASC",
  ].join(" "),
  notice_contract:
    "ORDER BY purpose_id ASC, notice_contract_id ASC, notice_contract_version ASC",
} satisfies Record<AuthorityStage, string>;

const EXPECTED_PARAMS = {
  auth_user: [AUTH_USER_ID, CANONICAL_ACTOR_ID],
  membership: [TENANT_ID, AUTH_USER_ID],
  epoch: [TENANT_ID, CANONICAL_ACTOR_ID],
  purpose: [PURPOSE_ID],
  entitlement: [TENANT_ID, PURPOSE_ID],
  consent: [TENANT_ID, CANONICAL_ACTOR_ID, PURPOSE_ID],
  receipt: [
    TENANT_ID,
    CANONICAL_ACTOR_ID,
    PURPOSE_ID,
    CONSENT_GENERATION,
    MEMBERSHIP_EPOCH,
    NOTICE_RECEIPT_ID,
  ],
  notice_contract: [
    PURPOSE_ID,
    NOTICE_CONTRACT_ID,
    NOTICE_CONTRACT_VERSION,
  ],
} satisfies Record<AuthorityStage, readonly unknown[]>;

beforeEach(() => {
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockReset();
  dbMocks.hasDatabaseUrl.mockReset();
  dbMocks.hasDatabaseUrl.mockReturnValue(true);
  dbMocks.runWithDatabaseTenantScope.mockReset();
  dbMocks.runWithDatabaseTenantScope.mockImplementation(
    async (_tenantId: string, operation: () => Promise<unknown>) =>
      operation(),
  );
});

describe("denial-only memory authority resolution canary", () => {
  it("rejects malformed inputs before checking PostgreSQL or issuing SQL", async () => {
    const { sql, calls } = fakeSql(handlerFor(coherentResponses()));
    dbMocks.getSql.mockReturnValue(sql);
    const invalidInputs: unknown[] = [
      {
        accessScope: { ...ACCESS_SCOPE, unexpected: true },
        actorBinding: ACTOR_BINDING,
      },
      {
        accessScope: ACCESS_SCOPE,
        actorBinding: { ...ACTOR_BINDING },
      },
      {
        accessScope: ACCESS_SCOPE,
        actorBinding: Object.freeze({
          ...ACTOR_BINDING,
          canonicalActorId:
            "actor:22222222-2222-4222-8222-222222222222",
        }),
      },
    ];

    for (const input of invalidInputs) {
      await expect(inspectMemoryAuthorityDenialCanary(
        input as Parameters<typeof inspectMemoryAuthorityDenialCanary>[0],
      )).rejects.toMatchObject({
        name: "MemoryAuthorityDenialCanaryError",
        code: "invalid_input",
        message: "Memory authority canary input is invalid.",
      });
    }

    expect(dbMocks.hasDatabaseUrl).not.toHaveBeenCalled();
    expect(dbMocks.getSql).not.toHaveBeenCalled();
    expect(dbMocks.runWithDatabaseTenantScope).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("fails closed without PostgreSQL and has no schema or file fallback", async () => {
    dbMocks.hasDatabaseUrl.mockReturnValue(false);

    await expect(inspectMemoryAuthorityDenialCanary(canaryInput()))
      .rejects.toMatchObject({
        name: "MemoryAuthorityDenialCanaryError",
        code: "postgres_required",
        message: "Memory authority canary requires PostgreSQL.",
      });

    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.getSql).not.toHaveBeenCalled();
    expect(dbMocks.runWithDatabaseTenantScope).not.toHaveBeenCalled();
  });

  it("owns one transaction entirely inside the exact tenant scope", async () => {
    const { sql, transactionSql, calls } = fakeSql(
      handlerFor(coherentResponses()),
    );
    let tenantScopeActive = false;
    dbMocks.runWithDatabaseTenantScope.mockImplementation(
      async (tenantId: string, operation: () => Promise<unknown>) => {
        expect(tenantId).toBe(TENANT_ID);
        expect(tenantScopeActive).toBe(false);
        tenantScopeActive = true;
        try {
          return await operation();
        } finally {
          tenantScopeActive = false;
        }
      },
    );
    dbMocks.getSql.mockImplementation(() => {
      expect(tenantScopeActive).toBe(true);
      return sql;
    });

    await expect(inspectMemoryAuthorityDenialCanary(canaryInput()))
      .resolves.toMatchObject({ decision: "deny" });

    expect(tenantScopeActive).toBe(false);
    expect(dbMocks.runWithDatabaseTenantScope).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(dbMocks.getSql).toHaveBeenCalledTimes(1);
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    expect(sql).not.toHaveBeenCalled();
    expect(transactionSql.transaction).not.toHaveBeenCalled();
    expect(calls.every((call) => call.client === "transaction")).toBe(true);
    expect(calls.every((call) => call.kind === "tag")).toBe(true);
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
  });

  it("preflights ordinary tenant scope with no installed memory scope", async () => {
    const invalidPreflights: Array<{
      rows: SqlRow[];
      transactionScoped?: boolean;
    }> = [
      { rows: [] },
      {
        rows: [
          preflightRow(),
          preflightRow(),
        ],
      },
      { rows: [preflightRow({ tenant_id: "tenant:other" })] },
      { rows: [preflightRow({ system_scope: "true" })] },
      { rows: [preflightRow({ system_scope: false })] },
      { rows: [preflightRow({ memory_access_scope: "{}" })] },
      { rows: [preflightRow()], transactionScoped: false },
    ];

    for (const candidate of invalidPreflights) {
      const responses = coherentResponses();
      responses.preflight = candidate.rows;
      const { sql, calls } = fakeSql(handlerFor(responses), {
        transactionScoped: candidate.transactionScoped,
      });
      dbMocks.getSql.mockReturnValue(sql);

      await expect(inspectMemoryAuthorityDenialCanary(canaryInput()))
        .rejects.toMatchObject({
          code: "database_scope_invariant",
          message: "Memory authority canary database scope was rejected.",
        });
      expect(calls.map(({ text }) => stageForText(text))).toEqual(
        candidate.transactionScoped === false ? [] : ["preflight"],
      );
    }
  });

  it("uses explicit bounded lock queries in deterministic authority order", async () => {
    const { sql, calls } = fakeSql(handlerFor(coherentResponses()));
    dbMocks.getSql.mockReturnValue(sql);

    await inspectMemoryAuthorityDenialCanary(canaryInput());

    expect(calls.map(({ text }) => stageForText(text))).toEqual(QUERY_STAGES);
    const preflight = calls[0];
    expect(preflight?.params).toEqual([]);
    expect(preflight?.text).toContain(
      "current_setting('omni.tenant_id', TRUE)",
    );
    expect(preflight?.text).toContain(
      "current_setting('omni.system_scope', TRUE)",
    );
    expect(preflight?.text).toContain(
      "current_setting('omni.memory_access_scope_v1', TRUE)",
    );

    for (const [index, stage] of AUTHORITY_STAGES.entries()) {
      const call = calls[index + 1];
      expect(call).toBeDefined();
      if (!call) throw new Error(`Missing captured ${stage} query.`);
      expect(selectedColumns(call.text)).toEqual(EXPECTED_COLUMNS[stage]);
      expect(call.text).toContain(EXPECTED_WHERE[stage]);
      expect(call.text).toContain(EXPECTED_ORDER_BY[stage]);
      expect(call.text).toContain("LIMIT 2");
      expect(call.text).toContain("FOR SHARE");
      expect(call.text).not.toMatch(/\bJOIN\b/i);
      expect(call.text).not.toContain("SELECT *");
      expect(call.params).toEqual(EXPECTED_PARAMS[stage]);
    }

    const receiptCall = calls.find(({ text }) =>
      stageForText(text) === "receipt"
    );
    expect(receiptCall?.params).toEqual([
      TENANT_ID,
      CANONICAL_ACTOR_ID,
      PURPOSE_ID,
      CONSENT_GENERATION,
      MEMBERSHIP_EPOCH,
      NOTICE_RECEIPT_ID,
    ]);
  });

  it("never mutates, installs authority scope, calls v45, or emits telemetry SQL", async () => {
    const { sql, calls } = fakeSql(handlerFor(coherentResponses()));
    dbMocks.getSql.mockReturnValue(sql);

    await inspectMemoryAuthorityDenialCanary(canaryInput());

    const capturedSql = calls.map(({ text }) => text).join("\n");
    const authoritySql = calls.slice(1).map(({ text }) => text).join("\n");
    expect(capturedSql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY)\b/i,
    );
    expect(capturedSql).not.toContain("set_config");
    expect(capturedSql).not.toContain(
      "omni_memory_access_scope_v1_is_authorized",
    );
    expect(capturedSql).not.toContain("omni_memory_access_scope_v1_is_valid");
    expect(capturedSql).not.toContain("omni_current_memory_access_scope_v1");
    expect(capturedSql).not.toContain("omni_system_scope_enabled");
    expect(capturedSql).not.toContain("omni_events");
    expect(capturedSql).not.toContain("omni_security_audits");
    expect(capturedSql).not.toContain("omni_observability_events");
    expect(capturedSql).not.toContain("pg_notify");
    expect(authoritySql).not.toContain("omni.system_scope");
    expect(authoritySql).not.toContain("omni.memory_access_scope_v1");
    expect(capturedSql.match(/omni\.system_scope/g)).toHaveLength(1);
    expect(capturedSql.match(/omni\.memory_access_scope_v1/g)).toHaveLength(1);
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
  });

  it("keeps coherent hypothetical active rows denied with frozen diagnostics", async () => {
    const { sql } = fakeSql(handlerFor(coherentResponses()));
    dbMocks.getSql.mockReturnValue(sql);

    const result = await inspectMemoryAuthorityDenialCanary(canaryInput());

    expect(result).toEqual({
      schemaVersion: MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION,
      decision: "deny",
      reason: "activation_held",
      unavailableAuthorities: BASELINE_UNAVAILABLE,
    });
    expect(Object.keys(result)).toEqual([
      "schemaVersion",
      "decision",
      "reason",
      "unavailableAuthorities",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.unavailableAuthorities)).toBe(true);
    expect(Object.isFrozen(MEMORY_AUTHORITY_UNAVAILABLE_CODES)).toBe(true);
    expect(MEMORY_AUTHORITY_UNAVAILABLE_CODES).toEqual([
      "canonical_scope_actor",
      "canonical_actor",
      "tenant_membership",
      "workspace_membership_authority",
      "membership_epoch",
      "purpose_contract",
      "tenant_entitlement",
      "standing_consent",
      "informed_notice_evidence",
      "executing_principal_authority",
      "context_grant_authority",
      "capability_grant_authority",
      "operation_policy_authority",
      "request_bound_data_right_authority",
    ]);
    expect(Reflect.set(result, "decision", "allow")).toBe(false);
    expect(() => {
      (result.unavailableAuthorities as string[]).push("canonical_actor");
    }).toThrow();
    expectCanonicalDiagnostics(result.unavailableAuthorities);

    const serialized = JSON.stringify(result);
    for (const privateCoordinate of [
      TENANT_ID,
      AUTH_USER_ID,
      CANONICAL_ACTOR_ID,
      LEGACY_ACTOR_ID,
      PURPOSE_ID,
      NOTICE_RECEIPT_ID,
      NOTICE_CONTRACT_ID,
      GRANTED_AT,
    ]) {
      expect(serialized).not.toContain(privateCoordinate);
    }
    expect(Object.values(result).some((value) => typeof value === "boolean"))
      .toBe(false);
  });

  it("locks and accepts one actor-controlled active agent principal", async () => {
    const responses = coherentResponses();
    responses.execution_principal = [{
      schema_version: "1",
      tenant_id: TENANT_ID,
      principal_kind: "agent",
      principal_id: "agent:asael",
      principal_generation: "3",
      controller_actor_id: CANONICAL_ACTOR_ID,
      state: "active",
      lifecycle_revision: "1",
    }];
    const { sql, calls } = fakeSql(handlerFor(responses));
    dbMocks.getSql.mockReturnValue(sql);
    const scopeWithClaims = Object.freeze({
      ...ACCESS_SCOPE,
      executingPrincipalType: "agent" as const,
      executingPrincipalId: "agent:asael",
      contextGrantIds: Object.freeze(["context:one"]),
      capabilityGrantIds: Object.freeze(["capability:one"]),
    });

    const result = await inspectMemoryAuthorityDenialCanary(
      canaryInput(scopeWithClaims),
    );

    expect(result.unavailableAuthorities).toEqual(BASELINE_UNAVAILABLE);
    const principalCall = calls.find(({ text }) =>
      stageForText(text) === "execution_principal"
    );
    expect(principalCall).toBeDefined();
    expect(principalCall?.text).toContain("LIMIT 2");
    expect(principalCall?.text).toContain("FOR SHARE");
    expect(principalCall?.params).toEqual([
      TENANT_ID,
      "agent",
      "agent:asael",
    ]);
    expectCanonicalDiagnostics(result.unavailableAuthorities);
  });

  it("keeps absent, duplicate, mismatched, or malformed agent principals unavailable", async () => {
    const variants: SqlRow[][] = [
      [],
      [activeAgentPrincipal(), activeAgentPrincipal()],
      [activeAgentPrincipal({ controller_actor_id: "actor:22222222-2222-4222-8222-222222222222" })],
      [activeAgentPrincipal({ principal_generation: "01" })],
      [activeAgentPrincipal({ state: "held", lifecycle_revision: "0" })],
    ];
    const agentScope = Object.freeze({
      ...ACCESS_SCOPE,
      executingPrincipalType: "agent" as const,
      executingPrincipalId: "agent:asael",
    });

    for (const rows of variants) {
      const responses = coherentResponses();
      responses.execution_principal = rows;
      const { sql } = fakeSql(handlerFor(responses));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(
        canaryInput(agentScope),
      );

      expect(result.unavailableAuthorities).toEqual([
        "executing_principal_authority",
        ...BASELINE_UNAVAILABLE,
      ]);
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("locks one active workspace and exact canonical-user membership", async () => {
    const responses = coherentResponses();
    responses.workspace = [activeWorkspace()];
    responses.workspace_membership = [activeUserWorkspaceMembership()];
    const { sql, calls } = fakeSql(handlerFor(responses));
    dbMocks.getSql.mockReturnValue(sql);
    const workspaceScope = Object.freeze({
      ...ACCESS_SCOPE,
      workspaceId: "workspace:authority-canary",
    });

    const result = await inspectMemoryAuthorityDenialCanary(
      canaryInput(workspaceScope),
    );

    expect(result.unavailableAuthorities).toEqual(BASELINE_UNAVAILABLE);
    expect(calls.map(({ text }) => stageForText(text))).toEqual([
      "preflight",
      "auth_user",
      "membership",
      "workspace",
      "workspace_membership",
      "epoch",
      "purpose",
      "entitlement",
      "consent",
      "receipt",
      "notice_contract",
    ]);
    for (const stage of ["workspace", "workspace_membership"] as const) {
      const call = calls.find(({ text }) => stageForText(text) === stage);
      expect(call?.text).toContain("LIMIT 2");
      expect(call?.text).toContain("FOR SHARE");
    }
    expectCanonicalDiagnostics(result.unavailableAuthorities);
  });

  it("denies a missing workspace or a project without its workspace coordinate", async () => {
    const candidates = [
      Object.freeze({
        ...ACCESS_SCOPE,
        workspaceId: "workspace:authority-canary",
      }),
      Object.freeze({
        ...ACCESS_SCOPE,
        projectId: "project:authority-canary",
      }),
    ];

    for (const scope of candidates) {
      const { sql, calls } = fakeSql(handlerFor(coherentResponses()));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(
        canaryInput(scope),
      );

      expect(result.unavailableAuthorities).toEqual([
        "workspace_membership_authority",
        ...BASELINE_UNAVAILABLE,
      ]);
      expect(calls.map(({ text }) => stageForText(text))).toEqual(
        scope.workspaceId === null
          ? ["preflight", "auth_user", "membership"]
          : ["preflight", "auth_user", "membership", "workspace"],
      );
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("pins an agent workspace membership to the resolved principal generation", async () => {
    const agentScope = Object.freeze({
      ...ACCESS_SCOPE,
      executingPrincipalType: "agent" as const,
      executingPrincipalId: "agent:asael",
      workspaceId: "workspace:authority-canary",
    });

    for (const [generation, expectedAvailable] of [["3", true], ["4", false]] as const) {
      const responses = coherentResponses();
      responses.execution_principal = [activeAgentPrincipal()];
      responses.workspace = [activeWorkspace()];
      responses.workspace_membership = [
        activeAgentWorkspaceMembership({
          subject_execution_principal_generation: generation,
        }),
      ];
      const { sql, calls } = fakeSql(handlerFor(responses));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(
        canaryInput(agentScope),
      );

      expect(result.unavailableAuthorities).toEqual(
        expectedAvailable
          ? BASELINE_UNAVAILABLE
          : ["workspace_membership_authority", ...BASELINE_UNAVAILABLE],
      );
      const stages = calls.map(({ text }) => stageForText(text));
      expect(stages.slice(0, 6)).toEqual([
        "preflight",
        "auth_user",
        "membership",
        "execution_principal",
        "workspace",
        "workspace_membership",
      ]);
      expect(stages.includes("epoch")).toBe(expectedAvailable);
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("reports a valid legacy request actor without exposing its identifier", async () => {
    const { sql, calls } = fakeSql(handlerFor(coherentResponses()));
    dbMocks.getSql.mockReturnValue(sql);
    const legacyScope = Object.freeze({
      ...ACCESS_SCOPE,
      initiatingActorId: LEGACY_ACTOR_ID,
      executingPrincipalId: LEGACY_ACTOR_ID,
    });

    const result = await inspectMemoryAuthorityDenialCanary(
      canaryInput(legacyScope),
    );

    expect(result).toEqual({
      schemaVersion: MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION,
      decision: "deny",
      reason: "activation_held",
      unavailableAuthorities: [
        "canonical_scope_actor",
        "executing_principal_authority",
        ...BASELINE_UNAVAILABLE,
      ],
    });
    expect(JSON.stringify(result)).not.toContain(LEGACY_ACTOR_ID);
    expect(calls.flatMap(({ params }) => params)).not.toContain(
      LEGACY_ACTOR_ID,
    );
    expectCanonicalDiagnostics(result.unavailableAuthorities);
  });

  it("stops dependent reads after every unavailable or malformed prerequisite", async () => {
    const variants = ["missing", "duplicate", "wrong", "malformed"] as const;
    const unavailableByStage = {
      auth_user: ["canonical_actor"],
      membership: ["tenant_membership"],
      epoch: ["membership_epoch"],
      purpose: ["purpose_contract"],
      entitlement: ["tenant_entitlement"],
      consent: ["standing_consent", "informed_notice_evidence"],
      receipt: ["informed_notice_evidence"],
      notice_contract: ["informed_notice_evidence"],
    } satisfies Record<AuthorityStage, readonly string[]>;

    for (const stage of AUTHORITY_STAGES) {
      for (const variant of variants) {
        const responses = coherentResponses();
        responses[stage] = corruptedRows(
          stage,
          variant,
          responses[stage][0],
        );
        const { sql, calls } = fakeSql(handlerFor(responses));
        dbMocks.getSql.mockReturnValue(sql);

        const result = await inspectMemoryAuthorityDenialCanary(canaryInput());
        const terminalIndex = QUERY_STAGES.indexOf(stage);
        expect(calls.map(({ text }) => stageForText(text))).toEqual(
          QUERY_STAGES.slice(0, terminalIndex + 1),
        );
        expect(result).toMatchObject({
          decision: "deny",
          reason: "activation_held",
        });
        for (const unavailable of unavailableByStage[stage]) {
          expect(result.unavailableAuthorities).toContain(unavailable);
        }
        expect(result.unavailableAuthorities).toEqual(
          expect.arrayContaining([...BASELINE_UNAVAILABLE]),
        );
        expectCanonicalDiagnostics(result.unavailableAuthorities);
      }
    }
  });

  it("rejects each mismatched receipt identity coordinate before notice lookup", async () => {
    const mismatches: SqlRow[] = [
      { tenant_id: "tenant:other" },
      {
        subject_actor_id:
          "actor:22222222-2222-4222-8222-222222222222",
      },
      { purpose_id: "memory.write.v1" },
      { consent_generation: String(CONSENT_GENERATION + 1) },
      { membership_epoch: String(MEMBERSHIP_EPOCH + 1) },
      { notice_receipt_id: "notice-receipt:other" },
    ];

    for (const mismatch of mismatches) {
      const responses = coherentResponses();
      responses.receipt = [{ ...responses.receipt[0], ...mismatch }];
      const { sql, calls } = fakeSql(handlerFor(responses));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(canaryInput());

      expect(calls.map(({ text }) => stageForText(text))).toEqual(
        QUERY_STAGES.slice(0, QUERY_STAGES.indexOf("notice_contract")),
      );
      expect(result.unavailableAuthorities).toEqual([
        "informed_notice_evidence",
        ...BASELINE_UNAVAILABLE,
      ]);
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("rejects noncanonical, nonpositive, fractional, and unsafe bigints", async () => {
    const invalidBigints: unknown[] = [
      " 7",
      "7 ",
      "1e1",
      "1.5",
      1.5,
      "-1",
      -1,
      "0",
      0,
      "9007199254740992",
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const invalidBigint of invalidBigints) {
      const responses = coherentResponses();
      responses.epoch = [{
        ...responses.epoch[0],
        membership_epoch: invalidBigint,
      }];
      const { sql, calls } = fakeSql(handlerFor(responses));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(canaryInput());

      expect(calls.map(({ text }) => stageForText(text))).toEqual(
        QUERY_STAGES.slice(0, QUERY_STAGES.indexOf("purpose")),
      );
      expect(result.unavailableAuthorities).toEqual([
        "membership_epoch",
        ...BASELINE_UNAVAILABLE,
      ]);
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("skips standing authorities for export and forget", async () => {
    for (const operationClass of ["export", "forget"] as const) {
      const purposeId = `memory.${operationClass}.v1`;
      const responses = coherentResponses(purposeId, operationClass);
      const { sql, calls } = fakeSql(handlerFor(responses));
      dbMocks.getSql.mockReturnValue(sql);

      const result = await inspectMemoryAuthorityDenialCanary(
        canaryInput(scopeForPurpose(purposeId)),
      );

      expect(calls.map(({ text }) => stageForText(text))).toEqual(
        QUERY_STAGES.slice(0, QUERY_STAGES.indexOf("purpose") + 1),
      );
      expect(result.unavailableAuthorities).toEqual([
        ...BASELINE_UNAVAILABLE,
        "request_bound_data_right_authority",
      ]);
      expect(result.unavailableAuthorities).not.toContain("tenant_entitlement");
      expect(result.unavailableAuthorities).not.toContain("standing_consent");
      expect(result.unavailableAuthorities).not.toContain(
        "informed_notice_evidence",
      );
      expectCanonicalDiagnostics(result.unavailableAuthorities);
    }
  });

  it("sanitizes database failures without retaining a sentinel or cause", async () => {
    const sentinel = "private-database-sentinel";
    const nestedCause = new Error("private-nested-cause");
    const responses = coherentResponses();
    const { sql, calls } = fakeSql((call) => {
      if (stageForText(call.text) === "membership") {
        throw Object.assign(new Error(sentinel), { cause: nestedCause });
      }
      return handlerFor(responses)(call);
    });
    dbMocks.getSql.mockReturnValue(sql);

    let observed: unknown;
    try {
      await inspectMemoryAuthorityDenialCanary(canaryInput());
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(MemoryAuthorityDenialCanaryError);
    expect(observed).toMatchObject({
      name: "MemoryAuthorityDenialCanaryError",
      code: "authority_read_failed",
      message: "Memory authority canary read failed.",
    });
    const sanitized = observed as MemoryAuthorityDenialCanaryError;
    expect(Object.prototype.hasOwnProperty.call(sanitized, "cause")).toBe(false);
    expect(String(sanitized)).not.toContain(sentinel);
    expect(String(sanitized.stack)).not.toContain(sentinel);
    expect(JSON.stringify(sanitized)).not.toContain(sentinel);
    expect(JSON.stringify(sanitized)).not.toContain("private-nested-cause");
    expect(calls.map(({ text }) => stageForText(text))).toEqual([
      "preflight",
      "auth_user",
      "membership",
    ]);
  });
});

function canaryInput(
  accessScope: unknown = ACCESS_SCOPE,
): Parameters<typeof inspectMemoryAuthorityDenialCanary>[0] {
  return { accessScope, actorBinding: ACTOR_BINDING };
}

function scopeForPurpose(purposeId: string) {
  return Object.freeze({ ...ACCESS_SCOPE, purposeId });
}

function preflightRow(overrides: SqlRow = {}): SqlRow {
  return {
    tenant_id: TENANT_ID,
    system_scope: "false",
    memory_access_scope: null,
    ...overrides,
  };
}

function coherentResponses(
  purposeId = PURPOSE_ID,
  operationClass = "read",
): QueryResponses {
  return {
    preflight: [preflightRow()],
    auth_user: [{
      id: AUTH_USER_ID,
      actor_id: CANONICAL_ACTOR_ID,
      status: "active",
    }],
    membership: [{
      id: "membership:authority-canary",
      tenant_id: TENANT_ID,
      user_id: AUTH_USER_ID,
      status: "active",
    }],
    epoch: [{
      schema_version: "1",
      tenant_id: TENANT_ID,
      subject_actor_id: CANONICAL_ACTOR_ID,
      membership_epoch: String(MEMBERSHIP_EPOCH),
      state: "active",
      lifecycle_revision: "1",
    }],
    purpose: [{
      purpose_id: purposeId,
      contract_version: "1",
      operation_class: operationClass,
    }],
    entitlement: [{
      schema_version: "1",
      tenant_id: TENANT_ID,
      purpose_id: purposeId,
      entitlement_generation: "3",
      state: "active",
      lifecycle_revision: "1",
    }],
    consent: [{
      schema_version: "2",
      tenant_id: TENANT_ID,
      subject_actor_id: CANONICAL_ACTOR_ID,
      purpose_id: purposeId,
      consent_generation: String(CONSENT_GENERATION),
      membership_epoch: String(MEMBERSHIP_EPOCH),
      notice_receipt_id: NOTICE_RECEIPT_ID,
      state: "granted",
      lifecycle_revision: "1",
      granted_by_actor_id: CANONICAL_ACTOR_ID,
      granted_at: GRANTED_AT,
    }],
    receipt: [{
      schema_version: "1",
      tenant_id: TENANT_ID,
      subject_actor_id: CANONICAL_ACTOR_ID,
      purpose_id: purposeId,
      consent_generation: String(CONSENT_GENERATION),
      membership_epoch: String(MEMBERSHIP_EPOCH),
      notice_receipt_id: NOTICE_RECEIPT_ID,
      notice_contract_id: NOTICE_CONTRACT_ID,
      notice_contract_version: String(NOTICE_CONTRACT_VERSION),
      presented_at: PRESENTED_AT,
      acknowledged_by_actor_id: CANONICAL_ACTOR_ID,
      acknowledged_at: ACKNOWLEDGED_AT,
    }],
    notice_contract: [{
      schema_version: "1",
      purpose_id: purposeId,
      notice_contract_id: NOTICE_CONTRACT_ID,
      notice_contract_version: String(NOTICE_CONTRACT_VERSION),
      notice_sha256: "a".repeat(64),
    }],
  };
}

function activeAgentPrincipal(overrides: SqlRow = {}): SqlRow {
  return {
    schema_version: "1",
    tenant_id: TENANT_ID,
    principal_kind: "agent",
    principal_id: "agent:asael",
    principal_generation: "3",
    controller_actor_id: CANONICAL_ACTOR_ID,
    state: "active",
    lifecycle_revision: "1",
    ...overrides,
  };
}

function activeWorkspace(overrides: SqlRow = {}): SqlRow {
  return {
    schema_version: "1",
    tenant_id: TENANT_ID,
    workspace_id: "workspace:authority-canary",
    state: "active",
    lifecycle_revision: "1",
    ...overrides,
  };
}

function activeUserWorkspaceMembership(overrides: SqlRow = {}): SqlRow {
  return {
    schema_version: "1",
    tenant_id: TENANT_ID,
    workspace_id: "workspace:authority-canary",
    subject_kind: "user",
    subject_key: CANONICAL_ACTOR_ID,
    subject_actor_id: CANONICAL_ACTOR_ID,
    subject_execution_principal_id: null,
    subject_execution_principal_generation: null,
    membership_generation: "2",
    access_level: "reader",
    state: "active",
    lifecycle_revision: "1",
    ...overrides,
  };
}

function activeAgentWorkspaceMembership(overrides: SqlRow = {}): SqlRow {
  return {
    schema_version: "1",
    tenant_id: TENANT_ID,
    workspace_id: "workspace:authority-canary",
    subject_kind: "agent",
    subject_key: "agent:asael",
    subject_actor_id: null,
    subject_execution_principal_id: "agent:asael",
    subject_execution_principal_generation: "3",
    membership_generation: "2",
    access_level: "reader",
    state: "active",
    lifecycle_revision: "1",
    ...overrides,
  };
}

function handlerFor(responses: QueryResponses) {
  return (call: QueryCall): SqlRow[] =>
    (responses[stageForText(call.text)] ?? []).map((row) => ({ ...row }));
}

function corruptedRows(
  stage: AuthorityStage,
  variant: "missing" | "duplicate" | "wrong" | "malformed",
  validRow: SqlRow,
): SqlRow[] {
  if (variant === "missing") return [];
  if (variant === "duplicate") return [validRow, { ...validRow }];
  const overrides = variant === "wrong"
    ? wrongCoordinate(stage)
    : malformedCoordinate(stage);
  return [{ ...validRow, ...overrides }];
}

function wrongCoordinate(stage: AuthorityStage): SqlRow {
  switch (stage) {
    case "auth_user":
      return { id: "22222222-2222-4222-8222-222222222222" };
    case "membership":
      return { tenant_id: "tenant:other" };
    case "epoch":
      return {
        subject_actor_id: "actor:22222222-2222-4222-8222-222222222222",
      };
    case "purpose":
      return { purpose_id: "memory.write.v1" };
    case "entitlement":
      return { purpose_id: "memory.write.v1" };
    case "consent":
      return { membership_epoch: String(MEMBERSHIP_EPOCH + 1) };
    case "receipt":
      return { notice_receipt_id: "notice-receipt:other" };
    case "notice_contract":
      return { notice_contract_id: "notice-contract:other" };
  }
}

function malformedCoordinate(stage: AuthorityStage): SqlRow {
  switch (stage) {
    case "auth_user":
      return { status: true };
    case "membership":
      return { id: " membership:invalid" };
    case "epoch":
      return { membership_epoch: "01" };
    case "purpose":
      return { operation_class: 42 };
    case "entitlement":
      return { lifecycle_revision: "2" };
    case "consent":
      return { granted_at: "not-a-timestamp" };
    case "receipt":
      return { acknowledged_at: "not-a-timestamp" };
    case "notice_contract":
      return { notice_sha256: "A".repeat(64) };
  }
}

function fakeSql(
  handler: (call: QueryCall) => SqlRow[] | Promise<SqlRow[]>,
  options: { transactionScoped?: boolean } = {},
) {
  const calls: QueryCall[] = [];
  const invoke = async (
    client: QueryCall["client"],
    kind: QueryCall["kind"],
    text: string,
    params: readonly unknown[],
  ) => {
    const call = {
      client,
      kind,
      text: normalizeSql(text),
      params,
    } satisfies QueryCall;
    calls.push(call);
    return handler(call);
  };
  const tagged = (client: QueryCall["client"]) =>
    vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) =>
      invoke(client, "tag", strings.join("?"), params)
    );
  const queried = (client: QueryCall["client"]) =>
    vi.fn(async (text: string, params: unknown[] = []) =>
      invoke(client, "query", text, params)
    );
  const unsafe = (client: QueryCall["client"]) =>
    vi.fn(async (text: string, params: unknown[] = []) =>
      invoke(client, "unsafe", text, params)
    );
  const transactionSql = Object.assign(tagged("transaction"), {
    query: queried("transaction"),
    unsafe: unsafe("transaction"),
    transactionScoped: options.transactionScoped ?? true,
    transaction: vi.fn(),
  });
  const sql = Object.assign(tagged("root"), {
    query: queried("root"),
    unsafe: unsafe("root"),
    transactionScoped: false,
    transaction: vi.fn(async (
      operation: (scopedSql: typeof transactionSql) => unknown,
    ) => operation(transactionSql)),
  });
  return { sql, transactionSql, calls };
}

function stageForText(text: string): QueryStage {
  if (text.includes("current_setting('omni.tenant_id'")) return "preflight";
  if (text.includes("FROM public.omni_auth_users")) return "auth_user";
  if (text.includes("FROM public.omni_auth_memberships")) return "membership";
  if (text.includes("FROM public.omni_tenant_execution_principals")) {
    return "execution_principal";
  }
  if (text.includes("FROM public.omni_tenant_workspace_memberships")) {
    return "workspace_membership";
  }
  if (text.includes("FROM public.omni_tenant_workspaces")) return "workspace";
  if (text.includes("FROM public.omni_tenant_actor_membership_epochs")) {
    return "epoch";
  }
  if (text.includes("FROM public.omni_memory_purpose_catalog")) return "purpose";
  if (
    text.includes("FROM public.omni_tenant_memory_purpose_entitlements")
  ) {
    return "entitlement";
  }
  if (
    text.includes("FROM public.omni_tenant_actor_memory_purpose_consents")
  ) {
    return "consent";
  }
  if (
    text.includes("FROM public.omni_tenant_actor_memory_notice_receipts")
  ) {
    return "receipt";
  }
  if (text.includes("FROM public.omni_memory_informed_notice_contracts")) {
    return "notice_contract";
  }
  throw new Error(`Unexpected SQL in authority canary test: ${text}`);
}

function selectedColumns(text: string): string[] {
  const match = /^SELECT (.+?) FROM /i.exec(text);
  if (!match) throw new Error(`Could not parse SELECT list: ${text}`);
  return match[1].split(",").map((column) => column.trim());
}

function expectCanonicalDiagnostics(values: readonly string[]) {
  const observed = new Set(values);
  expect(values).toEqual(
    MEMORY_AUTHORITY_UNAVAILABLE_CODES.filter((code) => observed.has(code)),
  );
  expect(observed.size).toBe(values.length);
}

function normalizeSql(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
