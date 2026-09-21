import "server-only";

import { createHash, randomBytes } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";

export const MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE =
  "moltbook.autonomy.cycle.v1" as const;
export const MOLTBOOK_AUTONOMY_POLICY_VERSION =
  "moltbook-autonomy-v1" as const;
export const MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION =
  "moltbook-autonomy-public-actions-v1" as const;
export const MOLTBOOK_AUTONOMY_ACTION_COOLDOWN_MS = 15 * 60 * 1_000;
export const MOLTBOOK_AUTONOMY_CYCLE_LEASE_MS = 30 * 60 * 1_000;

// Provider/model-derived prose must never become durable prompt material.
// Interests are therefore stored only as reviewed category labels.
export const MOLTBOOK_INTEREST_TOPICS = Object.freeze([
  "ai agents",
  "ai safety",
  "software engineering",
  "design",
  "productivity",
  "science",
  "research methods",
  "education",
  "philosophy",
  "art and creativity",
  "finance and economics",
  "social systems",
  "community building",
  "spirituality",
] as const);

const MOLTBOOK_INTEREST_TOPIC_SET = new Set<string>(MOLTBOOK_INTEREST_TOPICS);

export type MoltbookAutonomyOwner = Readonly<{
  tenantId: string;
  actorId: string;
}>;

export type MoltbookAutonomyBudgets = Readonly<{
  cycleIntervalSeconds: number;
  cycle: Readonly<{
    posts: number;
    comments: number;
    votes: number;
    follows: number;
    subscriptions: number;
  }>;
  daily: Readonly<{
    posts: number;
    comments: number;
    votes: number;
    follows: number;
    subscriptions: number;
  }>;
}>;

export const DEFAULT_MOLTBOOK_AUTONOMY_BUDGETS: MoltbookAutonomyBudgets =
  Object.freeze({
    cycleIntervalSeconds: 14_400,
    cycle: Object.freeze({
      posts: 1,
      comments: 2,
      votes: 4,
      follows: 1,
      subscriptions: 1,
    }),
    daily: Object.freeze({
      posts: 1,
      comments: 6,
      votes: 12,
      follows: 2,
      subscriptions: 2,
    }),
  });

export type MoltbookAuthorityPin = Readonly<{
  agentId: string;
  principalId: string;
  principalGeneration: number;
  principalSha256: string;
  definitionVersion: number;
  definitionSha256: string;
  policyBoundarySha256: string;
}>;

export type MoltbookAuthorityVersionProjection = MoltbookAuthorityPin & Readonly<{
  id: string;
  connectionId: string;
  authorityVersion: number;
  changeReason: "initial_connection" | "agent_rebind";
  changeRequestSha256: string;
  createdAt: string;
}>;

export type MoltbookAutonomyEnrollmentProjection = Readonly<{
  id: string;
  connectionId: string;
  agentId: string;
  enrollmentVersion: number;
  authorityVersion: number;
  status: "enabled" | "paused" | "revoked";
  charterSha256: string;
  budgets: MoltbookAutonomyBudgets;
  nextCycleAt: string;
  lastCycleAt?: string;
  enabledAt: string;
  lastPausedAt?: string;
  lastResumedAt?: string;
  revokedAt?: string;
}>;

export type MoltbookInterestProjection = Readonly<{
  topic: string;
  score: number;
  confidence: number;
  evidenceSha256s: readonly string[];
  observedAt: string;
}>;

export type MoltbookAutonomyListProjection = Readonly<{
  executable: boolean;
  blockedReason?: "connection_unavailable" | "authority_unavailable";
  enrollment?: MoltbookAutonomyEnrollmentProjection;
  authority?: MoltbookAuthorityVersionProjection;
  dailyUsage: Readonly<{
    posts: number;
    comments: number;
    votes: number;
    follows: number;
    subscriptions: number;
    resetAt: string;
  }>;
  interests: readonly MoltbookInterestProjection[];
  recentCycles: readonly Readonly<{
    id: string;
    status: "claimed" | "running" | "succeeded" | "failed";
    triggerKind: "scheduled" | "owner_requested";
    agentRunId?: string;
    scheduledFor: string;
    startedAt?: string;
    completedAt?: string;
    errorCode?: string;
  }>[];
}>;

export type MoltbookAutonomyCycleAuthority = MoltbookAuthorityPin & Readonly<{
  tenantId: string;
  ownerActorId: string;
  canonicalActorId: string;
  authUserId: string;
  membershipRole: "operator" | "admin";
  connectionId: string;
  enrollmentId: string;
  enrollmentVersion: number;
  authorityVersion: number;
  cycleId: string;
  executionPurpose: typeof MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE;
  correlationId: string;
}>;

export type ClaimedMoltbookAutonomyCycle = Readonly<{
  authority: MoltbookAutonomyCycleAuthority;
  leaseToken: string;
  leaseExpiresAt: string;
  triggerKind: "scheduled" | "owner_requested";
  interests: readonly MoltbookInterestProjection[];
}>;

export type MoltbookAutonomyMutationToolId =
  | "moltbook.post.create"
  | "moltbook.comment.create"
  | "moltbook.post.vote"
  | "moltbook.comment.upvote"
  | "moltbook.agent.follow"
  | "moltbook.submolt.subscribe";

export type MoltbookAutonomyActionAuthorization = Readonly<{
  claimId: string;
  cycleId: string;
  agentRunId: string;
  toolId: MoltbookAutonomyMutationToolId;
  toolInputSha256: string;
  effectTargetId: string;
  idempotencyKey: string;
  toolExecutionId: string;
  claimedAt: string;
  consumedAt: string;
  reused: boolean;
}>;

export class MoltbookAutonomyStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "database_required"
      | "invalid_input"
      | "not_found"
      | "conflict"
      | "not_enabled"
      | "stale_authority"
      | "lease_mismatch"
      | "budget_exhausted"
      | "cooldown_active",
  ) {
    super(message);
    this.name = "MoltbookAutonomyStoreError";
  }
}

type Sql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export async function listMoltbookAutonomyProjection(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
}): Promise<MoltbookAutonomyListProjection> {
  const owner = exactOwner(input.owner);
  const agentId = requiredId(input.agentId, 240, "Agent id");
  await databaseReady();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], async () => {
    const sql = getSql();
    const observedAt = new Date();
    const emptyDailyUsage = dailyUsageFromRow(undefined, observedAt);
    const enrollmentRows = await sql`
      SELECT enrollment.*
      FROM omni_moltbook_autonomy_enrollments enrollment
      WHERE enrollment.tenant_id = ${owner.tenantId}
        AND enrollment.owner_actor_id = ${owner.actorId}
        AND enrollment.agent_id = ${agentId}
      ORDER BY enrollment.enrollment_version DESC
      LIMIT 1
    `;
    const enrollmentRow = enrollmentRows[0];
    if (!enrollmentRow) {
      return {
        executable: false,
        dailyUsage: emptyDailyUsage,
        interests: [],
        recentCycles: [],
      };
    }
    const connectionId = String(enrollmentRow.connection_id);
    const [
      authorityRows,
      readinessRows,
      interestRows,
      cycleRows,
      dailyUsageRows,
    ] = await Promise.all([
      sql`
        SELECT * FROM omni_moltbook_authority_versions
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
          AND authority_version = ${Number(enrollmentRow.authority_version)}
        LIMIT 1
      `,
      sql`
        SELECT
          EXISTS (
            SELECT 1
            FROM omni_moltbook_connections connection
            WHERE connection.tenant_id = ${owner.tenantId}
              AND connection.owner_actor_id = ${owner.actorId}
              AND connection.id = ${connectionId}
              AND connection.agent_id = ${agentId}
              AND connection.status = 'claimed'
              AND connection.claim_state = 'claimed'
              AND connection.sealed_credentials IS NOT NULL
          ) AS connection_ready,
          EXISTS (
            SELECT 1
            FROM omni_moltbook_autonomy_enrollments exact_enrollment
            JOIN omni_moltbook_connections connection
              ON connection.tenant_id = exact_enrollment.tenant_id
              AND connection.owner_actor_id = exact_enrollment.owner_actor_id
              AND connection.id = exact_enrollment.connection_id
              AND connection.agent_id = exact_enrollment.agent_id
            JOIN omni_moltbook_authority_versions authority
              ON authority.tenant_id = exact_enrollment.tenant_id
              AND authority.owner_actor_id = exact_enrollment.owner_actor_id
              AND authority.connection_id = exact_enrollment.connection_id
              AND authority.id = exact_enrollment.authority_id
              AND authority.authority_version = exact_enrollment.authority_version
              AND authority.agent_id = exact_enrollment.agent_id
            JOIN omni_tenant_execution_principals principal
              ON principal.tenant_id = authority.tenant_id
              AND principal.principal_id = authority.principal_id
              AND principal.principal_generation = authority.principal_generation
              AND principal.principal_kind = 'agent'
              AND principal.agent_definition_id = exact_enrollment.agent_id
              AND principal.state = 'active'
            JOIN omni_agent_principal_policies policy
              ON policy.tenant_id = principal.tenant_id
              AND policy.principal_id = principal.principal_id
              AND policy.principal_generation = principal.principal_generation
            JOIN omni_custom_agents agent
              ON agent.tenant_id = exact_enrollment.tenant_id
              AND agent.actor_id = exact_enrollment.owner_actor_id
              AND agent.id = exact_enrollment.agent_id
            JOIN LATERAL public.omni_resolve_moltbook_owner_membership_v1(
              exact_enrollment.tenant_id,
              exact_enrollment.owner_actor_id
            ) owner_membership
              ON owner_membership.canonical_actor_id = principal.controller_actor_id
              AND owner_membership.canonical_actor_id =
                exact_enrollment.authorized_by_actor_id
            WHERE exact_enrollment.tenant_id = ${owner.tenantId}
              AND exact_enrollment.owner_actor_id = ${owner.actorId}
              AND exact_enrollment.id = ${String(enrollmentRow.id)}
              AND exact_enrollment.connection_id = ${connectionId}
              AND exact_enrollment.agent_id = ${agentId}
              AND connection.status = 'claimed'
              AND connection.claim_state = 'claimed'
              AND connection.sealed_credentials IS NOT NULL
              AND exact_enrollment.authority_version = (
                SELECT MAX(current_authority.authority_version)
                FROM omni_moltbook_authority_versions current_authority
                WHERE current_authority.tenant_id = exact_enrollment.tenant_id
                  AND current_authority.owner_actor_id = exact_enrollment.owner_actor_id
                  AND current_authority.connection_id = exact_enrollment.connection_id
              )
              AND policy.owner_actor_id = principal.controller_actor_id
              AND policy.agent_definition_id = exact_enrollment.agent_id
              AND policy.agent_definition_version = authority.definition_version
              AND policy.authority_mode = 'explicit_grants'
              AND (policy.expires_at IS NULL OR policy.expires_at > ${observedAt.toISOString()})
              AND agent.status IN ('ready', 'learning')
              AND authority.definition_version = (
                SELECT MAX(current_definition.definition_version)
                FROM omni_agent_definition_versions current_definition
                WHERE current_definition.tenant_id = exact_enrollment.tenant_id
                  AND current_definition.agent_definition_id = exact_enrollment.agent_id
              )
              AND cardinality(policy.context_grant_ids) = 0
              AND cardinality(policy.capability_grant_ids) = 0
              AND omni_moltbook_agent_boundary_is_exact_v1(
                agent.skill_ids, agent.tool_ids, agent.memory_scope,
                agent.autonomy, agent.approval_policy
              )
              AND omni_moltbook_agent_boundary_is_exact_v1(
                ARRAY[]::text[], policy.tool_grant_ids, policy.memory_scope,
                policy.autonomy, policy.approval_policy
              )
          ) AS executable
      `,
      readInterestProjection(sql, owner, connectionId),
      sql`
        SELECT id, status, trigger_kind, agent_run_id, scheduled_for,
               started_at, completed_at, error_code
        FROM omni_moltbook_autonomy_cycles
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
        ORDER BY created_at DESC, id DESC
        LIMIT 20
      `,
      sql`
        SELECT
          count(*) FILTER (WHERE action_kind = 'post')::int AS posts,
          count(*) FILTER (WHERE action_kind = 'comment')::int AS comments,
          count(*) FILTER (WHERE action_kind = 'vote')::int AS votes,
          count(*) FILTER (WHERE action_kind = 'follow')::int AS follows,
          count(*) FILTER (WHERE action_kind = 'subscribe')::int AS subscriptions,
          min(claimed_at) AS earliest_claimed_at
        FROM omni_moltbook_autonomy_action_claims
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
          AND status = 'consumed'
          AND claimed_at >= ${new Date(observedAt.getTime() - 86_400_000).toISOString()}
      `,
    ]);
    const readiness = executionReadinessFromRow(readinessRows[0]);
    return Object.freeze({
      executable: readiness.executable,
      ...(!readiness.executable
        ? {
            blockedReason: readiness.connectionReady
              ? "authority_unavailable" as const
              : "connection_unavailable" as const,
          }
        : {}),
      enrollment: enrollmentFromRow(enrollmentRow),
      authority: authorityRows[0]
        ? authorityFromRow(authorityRows[0])
        : undefined,
      dailyUsage: dailyUsageFromRow(dailyUsageRows[0], observedAt),
      interests: interestRows,
      recentCycles: cycleRows.map((row) => Object.freeze({
        id: String(row.id),
        status: requiredCycleStatus(row.status),
        triggerKind: row.trigger_kind === "owner_requested"
          ? "owner_requested" as const
          : "scheduled" as const,
        agentRunId: optionalString(row.agent_run_id),
        scheduledFor: iso(row.scheduled_for),
        startedAt: optionalIso(row.started_at),
        completedAt: optionalIso(row.completed_at),
        errorCode: optionalString(row.error_code),
      })),
    });
  });
}

function executionReadinessFromRow(row: SqlRow | undefined) {
  return Object.freeze({
    connectionReady: exactSqlBoolean(row?.connection_ready),
    executable: exactSqlBoolean(row?.executable),
  });
}

function exactSqlBoolean(value: unknown) {
  return value === true || value === "true";
}

function dailyUsageFromRow(
  row: SqlRow | undefined,
  observedAt: Date,
): MoltbookAutonomyListProjection["dailyUsage"] {
  const earliestClaimedAt = optionalIso(row?.earliest_claimed_at);
  const resetAt = earliestClaimedAt
    ? new Date(new Date(earliestClaimedAt).getTime() + 86_400_000).toISOString()
    : new Date(observedAt.getTime() + 86_400_000).toISOString();
  return Object.freeze({
    posts: Number(row?.posts || 0),
    comments: Number(row?.comments || 0),
    votes: Number(row?.votes || 0),
    follows: Number(row?.follows || 0),
    subscriptions: Number(row?.subscriptions || 0),
    resetAt,
  });
}

export async function insertCurrentMoltbookAuthorityVersion(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
  pin: MoltbookAuthorityPin;
  changeRequestSha256: string;
  reason?: "agent_rebind";
}): Promise<MoltbookAuthorityVersionProjection> {
  const owner = exactOwner(input.owner);
  const agentId = requiredId(input.agentId, 240, "Agent id");
  const pin = exactPin(input.pin);
  if (pin.agentId !== agentId) invalid("Agent authority pin does not match the Agent.");
  const changeRequestSha256 = digest(input.changeRequestSha256, "change request");
  await databaseReady();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], () =>
    getSql().transaction(async (sql: Sql) => {
      await advisoryLock(sql, `moltbook-authority:${owner.tenantId}:${owner.actorId}:${agentId}`);
      const connectionRows = await sql`
        SELECT id FROM omni_moltbook_connections
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND agent_id = ${agentId}
          AND status <> 'revoked'
        LIMIT 2
        FOR UPDATE
      `;
      const connectionId = exactlyOneString(connectionRows, "id", "Moltbook connection");
      const currentRows = await sql`
        SELECT * FROM omni_moltbook_authority_versions
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
        ORDER BY authority_version DESC
        LIMIT 1
      `;
      const current = currentRows[0];
      if (current && pinsEqual(authorityFromRow(current), pin)) {
        return authorityFromRow(current);
      }
      const activeEnrollment = await sql`
        SELECT 1 FROM omni_moltbook_autonomy_enrollments
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
          AND status <> 'revoked'
        LIMIT 1
      `;
      if (activeEnrollment.length) {
        throw new MoltbookAutonomyStoreError(
          "Revoke the current autonomy enrollment before rebinding Agent authority.",
          "conflict",
        );
      }
      const authorityVersion = Number(current?.authority_version || 0) + 1;
      const createdAt = new Date().toISOString();
      const id = opaqueId("moltbook_authority");
      const rows = await sql`
        INSERT INTO omni_moltbook_authority_versions (
          id, tenant_id, owner_actor_id, agent_id, connection_id,
          authority_version, principal_id, principal_generation,
          principal_sha256, definition_version, definition_sha256,
          policy_boundary_sha256, change_reason, change_request_sha256,
          created_at
        ) VALUES (
          ${id}, ${owner.tenantId}, ${owner.actorId}, ${agentId},
          ${connectionId}, ${authorityVersion}, ${pin.principalId},
          ${pin.principalGeneration}, ${pin.principalSha256},
          ${pin.definitionVersion}, ${pin.definitionSha256},
          ${pin.policyBoundarySha256}, ${input.reason || "agent_rebind"},
          ${changeRequestSha256}, ${createdAt}
        ) RETURNING *
      `;
      await appendEvent(sql, {
        owner,
        agentId,
        connectionId,
        eventType: "moltbook.autonomy.authority.bound",
        payload: { id, authorityVersion, changeRequestSha256 },
        createdAt,
      });
      return authorityFromRow(exactlyOne(rows, "Moltbook authority version"));
    }) as Promise<MoltbookAuthorityVersionProjection>
  );
}

export async function enableMoltbookAutonomy(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
  authorizedByCanonicalActorId: string;
  charterSha256: string;
  budgets?: MoltbookAutonomyBudgets;
}): Promise<MoltbookAutonomyEnrollmentProjection> {
  const owner = exactOwner(input.owner);
  const agentId = requiredId(input.agentId, 240, "Agent id");
  const authorizedBy = requiredId(
    input.authorizedByCanonicalActorId,
    320,
    "authorizing actor id",
  );
  const charterSha256 = digest(input.charterSha256, "autonomy charter");
  const budgets = exactBudgets(input.budgets || DEFAULT_MOLTBOOK_AUTONOMY_BUDGETS);
  await databaseReady();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId, authorizedBy], () =>
    getSql().transaction(async (sql: Sql) => {
      await advisoryLock(sql, `moltbook-enrollment:${owner.tenantId}:${owner.actorId}:${agentId}`);
      const rows = await sql`
        SELECT connection.id AS connection_id,
               authority.id AS authority_id,
               authority.authority_version
        FROM omni_moltbook_connections connection
        JOIN LATERAL (
          SELECT current_authority.id, current_authority.authority_version
          FROM omni_moltbook_authority_versions current_authority
          WHERE current_authority.tenant_id = connection.tenant_id
            AND current_authority.owner_actor_id = connection.owner_actor_id
            AND current_authority.connection_id = connection.id
          ORDER BY current_authority.authority_version DESC
          LIMIT 1
        ) authority ON TRUE
        WHERE connection.tenant_id = ${owner.tenantId}
          AND connection.owner_actor_id = ${owner.actorId}
          AND connection.agent_id = ${agentId}
          AND connection.status = 'claimed'
          AND connection.claim_state = 'claimed'
        LIMIT 2
        FOR UPDATE OF connection
      `;
      const boundary = exactlyOne(rows, "claimed Moltbook connection");
      const connectionId = String(boundary.connection_id);
      const existing = await sql`
        SELECT 1 FROM omni_moltbook_autonomy_enrollments
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
          AND status <> 'revoked'
        LIMIT 1
      `;
      if (existing.length) {
        throw new MoltbookAutonomyStoreError(
          "Moltbook autonomy is already enrolled for this Agent.",
          "conflict",
        );
      }
      const versionRows = await sql`
        SELECT COALESCE(MAX(enrollment_version), 0) + 1 AS next_version
        FROM omni_moltbook_autonomy_enrollments
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND connection_id = ${connectionId}
      `;
      const enrollmentVersion = safePositive(versionRows[0]?.next_version, "enrollment version");
      const now = new Date().toISOString();
      const id = opaqueId("moltbook_enrollment");
      const inserted = await sql`
        INSERT INTO omni_moltbook_autonomy_enrollments (
          id, tenant_id, owner_actor_id, agent_id, connection_id,
          enrollment_version, authority_id, authority_version, status,
          policy_version, charter_sha256, disclosure_version,
          authorized_by_actor_id, cycle_interval_seconds,
          cycle_post_limit, cycle_comment_limit, cycle_vote_limit,
          cycle_follow_limit, cycle_subscribe_limit, daily_post_limit,
          daily_comment_limit, daily_vote_limit, daily_follow_limit,
          daily_subscribe_limit, next_cycle_at, enabled_at, created_at, updated_at
        ) VALUES (
          ${id}, ${owner.tenantId}, ${owner.actorId}, ${agentId},
          ${connectionId}, ${enrollmentVersion}, ${String(boundary.authority_id)},
          ${Number(boundary.authority_version)}, 'enabled',
          ${MOLTBOOK_AUTONOMY_POLICY_VERSION}, ${charterSha256},
          ${MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION}, ${authorizedBy},
          ${budgets.cycleIntervalSeconds}, ${budgets.cycle.posts},
          ${budgets.cycle.comments}, ${budgets.cycle.votes},
          ${budgets.cycle.follows}, ${budgets.cycle.subscriptions},
          ${budgets.daily.posts}, ${budgets.daily.comments},
          ${budgets.daily.votes}, ${budgets.daily.follows},
          ${budgets.daily.subscriptions}, ${now}, ${now}, ${now}, ${now}
        ) RETURNING *
      `;
      await appendEvent(sql, {
        owner,
        agentId,
        connectionId,
        enrollmentId: id,
        eventType: "moltbook.autonomy.enrollment.enabled",
        payload: { id, enrollmentVersion, charterSha256 },
        createdAt: now,
      });
      return enrollmentFromRow(exactlyOne(inserted, "Moltbook autonomy enrollment"));
    }) as Promise<MoltbookAutonomyEnrollmentProjection>
  );
}

export async function pauseMoltbookAutonomy(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
}): Promise<MoltbookAutonomyEnrollmentProjection> {
  return transitionEnrollment(input, "paused");
}

export async function resumeMoltbookAutonomy(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
}): Promise<MoltbookAutonomyEnrollmentProjection> {
  return transitionEnrollment(input, "enabled");
}

export async function revokeMoltbookAutonomy(input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
}): Promise<MoltbookAutonomyEnrollmentProjection> {
  return transitionEnrollment(input, "revoked");
}

export async function claimDueMoltbookAutonomyCycle(input: {
  tenantId: string;
  leaseOwner: string;
  exactOwner?: MoltbookAutonomyOwner;
  agentId?: string;
  forceDue?: boolean;
}): Promise<ClaimedMoltbookAutonomyCycle | null> {
  const tenantId = requiredId(input.tenantId, 160, "tenant id");
  const leaseOwner = requiredId(input.leaseOwner, 160, "lease owner");
  const exactOwner = input.exactOwner ? exactOwnerValue(input.exactOwner) : undefined;
  if (exactOwner && exactOwner.tenantId !== tenantId) {
    invalid("The exact Moltbook owner does not belong to the scheduled tenant.");
  }
  const agentId = input.agentId
    ? requiredId(input.agentId, 240, "Agent id")
    : undefined;
  if (input.forceDue && (!exactOwner || !agentId)) {
    invalid("Owner-requested cycles require an exact owner and Agent id.");
  }
  await databaseReady();
  const operation = async () => getSql().transaction(async (sql: Sql) => {
    const now = new Date();
    const nowIso = now.toISOString();
    await recoverExpiredMoltbookCycles(sql, {
      tenantId,
      ownerActorId: exactOwner?.actorId,
      nowIso,
    });
    const candidates = await sql`
      SELECT enrollment.*, authority.id AS exact_authority_id,
             authority.principal_id, authority.principal_generation,
             authority.principal_sha256, authority.definition_version,
             authority.definition_sha256, authority.policy_boundary_sha256,
             owner_membership.canonical_actor_id,
             owner_membership.auth_user_id,
             owner_membership.membership_role
      FROM omni_moltbook_autonomy_enrollments enrollment
      JOIN omni_moltbook_connections connection
        ON connection.tenant_id = enrollment.tenant_id
        AND connection.owner_actor_id = enrollment.owner_actor_id
        AND connection.id = enrollment.connection_id
      JOIN omni_moltbook_authority_versions authority
        ON authority.tenant_id = enrollment.tenant_id
        AND authority.owner_actor_id = enrollment.owner_actor_id
        AND authority.connection_id = enrollment.connection_id
        AND authority.authority_version = enrollment.authority_version
        AND authority.id = enrollment.authority_id
      JOIN omni_tenant_execution_principals principal
        ON principal.tenant_id = authority.tenant_id
        AND principal.principal_id = authority.principal_id
        AND principal.principal_generation = authority.principal_generation
        AND principal.state = 'active'
      JOIN omni_agent_principal_policies policy
        ON policy.tenant_id = principal.tenant_id
        AND policy.principal_id = principal.principal_id
        AND policy.principal_generation = principal.principal_generation
      JOIN omni_custom_agents agent
        ON agent.tenant_id = enrollment.tenant_id
        AND agent.actor_id = enrollment.owner_actor_id
        AND agent.id = enrollment.agent_id
      JOIN LATERAL public.omni_resolve_moltbook_owner_membership_v1(
        enrollment.tenant_id,
        enrollment.owner_actor_id
      ) owner_membership
        ON owner_membership.canonical_actor_id = principal.controller_actor_id
        AND owner_membership.canonical_actor_id =
          enrollment.authorized_by_actor_id
      WHERE enrollment.status = 'enabled'
        AND enrollment.tenant_id = ${tenantId}
        AND connection.status = 'claimed'
        AND connection.claim_state = 'claimed'
        AND enrollment.authority_version = (
          SELECT MAX(current_authority.authority_version)
          FROM omni_moltbook_authority_versions current_authority
          WHERE current_authority.tenant_id = enrollment.tenant_id
            AND current_authority.owner_actor_id = enrollment.owner_actor_id
            AND current_authority.connection_id = enrollment.connection_id
        )
        AND policy.owner_actor_id = principal.controller_actor_id
        AND policy.agent_definition_id = enrollment.agent_id
        AND policy.agent_definition_version = authority.definition_version
        AND policy.authority_mode = 'explicit_grants'
        AND (policy.expires_at IS NULL OR policy.expires_at > ${nowIso})
        AND agent.status IN ('ready', 'learning')
        AND authority.definition_version = (
          SELECT MAX(current_definition.definition_version)
          FROM omni_agent_definition_versions current_definition
          WHERE current_definition.tenant_id = enrollment.tenant_id
            AND current_definition.agent_definition_id = enrollment.agent_id
        )
        AND cardinality(policy.context_grant_ids) = 0
        AND cardinality(policy.capability_grant_ids) = 0
        AND omni_moltbook_agent_boundary_is_exact_v1(
          agent.skill_ids, agent.tool_ids, agent.memory_scope,
          agent.autonomy, agent.approval_policy
        )
        AND omni_moltbook_agent_boundary_is_exact_v1(
          ARRAY[]::text[], policy.tool_grant_ids, policy.memory_scope,
          policy.autonomy, policy.approval_policy
        )
        AND (${input.forceDue === true} OR enrollment.next_cycle_at <= ${nowIso})
        AND (${exactOwner?.tenantId || null}::text IS NULL
          OR enrollment.tenant_id = ${exactOwner?.tenantId || null})
        AND (${exactOwner?.actorId || null}::text IS NULL
          OR enrollment.owner_actor_id = ${exactOwner?.actorId || null})
        AND (${agentId || null}::text IS NULL OR enrollment.agent_id = ${agentId || null})
        AND NOT EXISTS (
          SELECT 1 FROM omni_moltbook_autonomy_cycles active_cycle
          WHERE active_cycle.tenant_id = enrollment.tenant_id
            AND active_cycle.owner_actor_id = enrollment.owner_actor_id
            AND active_cycle.enrollment_id = enrollment.id
            AND active_cycle.status IN ('claimed', 'running')
        )
      ORDER BY enrollment.next_cycle_at ASC, enrollment.id ASC
      LIMIT 1
      FOR UPDATE OF enrollment SKIP LOCKED
    `;
    const row = candidates[0];
    if (!row) return null;
    const cycleId = opaqueId("moltbook_cycle");
    const leaseToken = randomBytes(32).toString("hex");
    const leaseExpiresAt = new Date(now.getTime() + MOLTBOOK_AUTONOMY_CYCLE_LEASE_MS).toISOString();
    const nextCycleAt = new Date(
      now.getTime() + Number(row.cycle_interval_seconds) * 1_000,
    ).toISOString();
    await sql`
      UPDATE omni_moltbook_autonomy_enrollments
      SET last_cycle_at = ${nowIso}, next_cycle_at = GREATEST(next_cycle_at, ${nextCycleAt}::timestamptz),
          updated_at = ${nowIso}
      WHERE tenant_id = ${String(row.tenant_id)}
        AND owner_actor_id = ${String(row.owner_actor_id)}
        AND id = ${String(row.id)}
        AND status = 'enabled'
    `;
    await sql`
      INSERT INTO omni_moltbook_autonomy_cycles (
        id, tenant_id, owner_actor_id, agent_id, connection_id,
        enrollment_id, enrollment_version, authority_version, trigger_kind,
        execution_purpose, correlation_id, status, scheduled_for, claimed_at,
        membership_role, lease_owner, lease_token_sha256, lease_expires_at,
        created_at, updated_at
      ) VALUES (
        ${cycleId}, ${String(row.tenant_id)}, ${String(row.owner_actor_id)},
        ${String(row.agent_id)}, ${String(row.connection_id)}, ${String(row.id)},
        ${Number(row.enrollment_version)}, ${Number(row.authority_version)},
        ${input.forceDue ? "owner_requested" : "scheduled"},
        ${MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE}, ${cycleId}, 'claimed',
        ${input.forceDue ? nowIso : iso(row.next_cycle_at)}, ${nowIso},
        ${requiredMembershipRole(row.membership_role)}, ${leaseOwner},
        ${sha256(leaseToken)}, ${leaseExpiresAt}, ${nowIso}, ${nowIso}
      )
    `;
    const owner = {
      tenantId: String(row.tenant_id),
      actorId: String(row.owner_actor_id),
    };
    await appendEvent(sql, {
      owner,
      agentId: String(row.agent_id),
      connectionId: String(row.connection_id),
      enrollmentId: String(row.id),
      cycleId,
      eventType: "moltbook.autonomy.cycle.claimed",
      payload: { cycleId, authorityVersion: Number(row.authority_version) },
      createdAt: nowIso,
    });
    const authority: MoltbookAutonomyCycleAuthority = Object.freeze({
      tenantId: owner.tenantId,
      ownerActorId: owner.actorId,
      canonicalActorId: String(row.canonical_actor_id),
      authUserId: String(row.auth_user_id),
      membershipRole: requiredMembershipRole(row.membership_role),
      connectionId: String(row.connection_id),
      enrollmentId: String(row.id),
      enrollmentVersion: Number(row.enrollment_version),
      authorityVersion: Number(row.authority_version),
      cycleId,
      executionPurpose: MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE,
      correlationId: cycleId,
      agentId: String(row.agent_id),
      principalId: String(row.principal_id),
      principalGeneration: Number(row.principal_generation),
      principalSha256: String(row.principal_sha256),
      definitionVersion: Number(row.definition_version),
      definitionSha256: String(row.definition_sha256),
      policyBoundarySha256: String(row.policy_boundary_sha256),
    });
    return Object.freeze({
      authority,
      leaseToken,
      leaseExpiresAt,
      triggerKind: input.forceDue ? "owner_requested" as const : "scheduled" as const,
      interests: await readInterestProjection(sql, owner, authority.connectionId),
    });
  }) as Promise<ClaimedMoltbookAutonomyCycle | null>;
  return exactOwner
    ? runWithDatabaseActorScope(
      exactOwner.tenantId,
      [exactOwner.actorId],
      operation,
    )
    : runWithDatabaseSystemScope(`claim due Moltbook autonomy cycle for tenant ${tenantId}`, operation);
}

export async function attachMoltbookAutonomyCycleRun(input: {
  authority: MoltbookAutonomyCycleAuthority;
  leaseToken: string;
  runId: string;
}): Promise<void> {
  const authority = exactCycleAuthority(input.authority);
  const leaseSha = sha256(requiredSecret(input.leaseToken, "cycle lease token"));
  const runId = requiredId(input.runId, 240, "Agent run id");
  await databaseReady();
  await runWithDatabaseActorScope(
    authority.tenantId,
    [authority.canonicalActorId, authority.ownerActorId],
    () =>
    getSql().transaction(async (sql: Sql) => {
      const now = new Date().toISOString();
      const rows = await sql`
        UPDATE omni_moltbook_autonomy_cycles cycle
        SET status = 'running', agent_run_id = ${runId}, started_at = ${now},
            updated_at = ${now}
        WHERE cycle.tenant_id = ${authority.tenantId}
          AND cycle.owner_actor_id = ${authority.ownerActorId}
          AND cycle.id = ${authority.cycleId}
          AND cycle.connection_id = ${authority.connectionId}
          AND cycle.enrollment_id = ${authority.enrollmentId}
          AND cycle.authority_version = ${authority.authorityVersion}
          AND cycle.execution_purpose = ${authority.executionPurpose}
          AND cycle.correlation_id = ${authority.correlationId}
          AND cycle.lease_token_sha256 = ${leaseSha}
          AND cycle.lease_expires_at > ${now}
          AND cycle.status = 'claimed'
        RETURNING cycle.id
      `;
      if (rows.length !== 1) leaseMismatch();
      await appendEvent(sql, {
        owner: { tenantId: authority.tenantId, actorId: authority.ownerActorId },
        agentId: authority.agentId,
        connectionId: authority.connectionId,
        enrollmentId: authority.enrollmentId,
        cycleId: authority.cycleId,
        eventType: "moltbook.autonomy.cycle.started",
        payload: { cycleId: authority.cycleId, runId },
        createdAt: now,
      });
    }),
  );
}

export async function completeMoltbookAutonomyCycle(input: {
  authority: MoltbookAutonomyCycleAuthority;
  leaseToken: string;
  outcome:
    | Readonly<{ status: "succeeded"; outcomeSha256: string; summarySha256?: string }>
    | Readonly<{ status: "failed"; errorCode: string; summarySha256?: string }>;
}): Promise<void> {
  const authority = exactCycleAuthority(input.authority);
  const leaseSha = sha256(requiredSecret(input.leaseToken, "cycle lease token"));
  const summarySha = input.outcome.summarySha256
    ? digest(input.outcome.summarySha256, "cycle summary")
    : null;
  const outcomeSha = input.outcome.status === "succeeded"
    ? digest(input.outcome.outcomeSha256, "cycle outcome")
    : null;
  const errorCode = input.outcome.status === "failed"
    ? requiredErrorCode(input.outcome.errorCode)
    : null;
  await databaseReady();
  await runWithDatabaseActorScope(
    authority.tenantId,
    [authority.canonicalActorId, authority.ownerActorId],
    () =>
    getSql().transaction(async (sql: Sql) => {
      const now = new Date().toISOString();
      const rows = await sql`
        UPDATE omni_moltbook_autonomy_cycles cycle
        SET status = ${input.outcome.status}, completed_at = ${now},
            outcome_sha256 = ${outcomeSha}, summary_sha256 = ${summarySha},
            error_code = ${errorCode}, updated_at = ${now}
        WHERE cycle.tenant_id = ${authority.tenantId}
          AND cycle.owner_actor_id = ${authority.ownerActorId}
          AND cycle.id = ${authority.cycleId}
          AND cycle.connection_id = ${authority.connectionId}
          AND cycle.enrollment_id = ${authority.enrollmentId}
          AND cycle.authority_version = ${authority.authorityVersion}
          AND cycle.lease_token_sha256 = ${leaseSha}
          AND cycle.lease_expires_at > ${now}
          AND cycle.status IN ('claimed', 'running')
        RETURNING cycle.id
      `;
      if (rows.length !== 1) leaseMismatch();
      await appendEvent(sql, {
        owner: { tenantId: authority.tenantId, actorId: authority.ownerActorId },
        agentId: authority.agentId,
        connectionId: authority.connectionId,
        enrollmentId: authority.enrollmentId,
        cycleId: authority.cycleId,
        eventType: "moltbook.autonomy.cycle.completed",
        payload: {
          cycleId: authority.cycleId,
          status: input.outcome.status,
          digest: outcomeSha || summarySha || sha256(errorCode || "failed"),
        },
        createdAt: now,
      });
    }),
  );
}

/**
 * Atomically budgets and consumes one exact standing authorization. A retry
 * with the same idempotency key succeeds only when every binding, including
 * the deterministic tool execution id, is identical.
 */
export async function authorizeMoltbookAutonomyAction(input: {
  authority: MoltbookAutonomyCycleAuthority;
  leaseToken: string;
  toolId: MoltbookAutonomyMutationToolId;
  toolInputSha256: string;
  effectTargetId: string;
  idempotencyKey: string;
  toolExecutionId: string;
  agentRunId: string;
  executionPurpose: typeof MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE;
  correlationId: string;
  principalId: string;
  principalGeneration: number;
}): Promise<MoltbookAutonomyActionAuthorization> {
  const authority = exactCycleAuthority(input.authority);
  if (
    input.executionPurpose !== MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE ||
    input.executionPurpose !== authority.executionPurpose ||
    input.correlationId !== authority.cycleId ||
    input.correlationId !== authority.correlationId ||
    input.principalId !== authority.principalId ||
    input.principalGeneration !== authority.principalGeneration
  ) {
    throw new MoltbookAutonomyStoreError(
      "Autonomy action execution authority does not match its cycle.",
      "stale_authority",
    );
  }
  const leaseSha = sha256(requiredSecret(input.leaseToken, "cycle lease token"));
  const toolId = actionKindForTool(input.toolId).toolId;
  const toolInputSha256 = digest(input.toolInputSha256, "tool input");
  const effectTargetId = requiredTarget(input.effectTargetId);
  const idempotencyKey = requiredId(input.idempotencyKey, 240, "idempotency key");
  if (idempotencyKey.length < 16 || /\s/.test(idempotencyKey)) invalid("Invalid idempotency key.");
  const toolExecutionId = requiredId(input.toolExecutionId, 240, "tool execution id");
  const agentRunId = requiredId(input.agentRunId, 240, "Agent run id");
  await databaseReady();
  return runWithDatabaseActorScope(
    authority.tenantId,
    [authority.canonicalActorId, authority.ownerActorId],
    () =>
    getSql().transaction(async (sql: Sql) => {
      await advisoryLock(sql, `moltbook-action:${authority.tenantId}:${authority.connectionId}`);
      const now = new Date();
      const nowIso = now.toISOString();
      const cycleRows = await sql`
        SELECT cycle.*, enrollment.status AS enrollment_status,
               enrollment.cycle_post_limit, enrollment.cycle_comment_limit,
               enrollment.cycle_vote_limit, enrollment.cycle_follow_limit,
               enrollment.cycle_subscribe_limit, enrollment.daily_post_limit,
               enrollment.daily_comment_limit, enrollment.daily_vote_limit,
               enrollment.daily_follow_limit, enrollment.daily_subscribe_limit,
               owner_membership.membership_role AS current_membership_role
        FROM omni_moltbook_autonomy_cycles cycle
        JOIN omni_moltbook_autonomy_enrollments enrollment
          ON enrollment.tenant_id = cycle.tenant_id
          AND enrollment.owner_actor_id = cycle.owner_actor_id
          AND enrollment.id = cycle.enrollment_id
          AND enrollment.enrollment_version = cycle.enrollment_version
          AND enrollment.authority_version = cycle.authority_version
        JOIN omni_moltbook_connections connection
          ON connection.tenant_id = cycle.tenant_id
          AND connection.owner_actor_id = cycle.owner_actor_id
          AND connection.id = cycle.connection_id
          AND connection.agent_id = cycle.agent_id
        JOIN omni_moltbook_authority_versions exact_authority
          ON exact_authority.tenant_id = cycle.tenant_id
          AND exact_authority.owner_actor_id = cycle.owner_actor_id
          AND exact_authority.connection_id = cycle.connection_id
          AND exact_authority.authority_version = cycle.authority_version
          AND exact_authority.id = enrollment.authority_id
        JOIN omni_tenant_execution_principals principal
          ON principal.tenant_id = exact_authority.tenant_id
          AND principal.principal_id = exact_authority.principal_id
          AND principal.principal_generation = exact_authority.principal_generation
        JOIN omni_agent_principal_policies policy
          ON policy.tenant_id = principal.tenant_id
          AND policy.principal_id = principal.principal_id
          AND policy.principal_generation = principal.principal_generation
        JOIN omni_custom_agents agent
          ON agent.tenant_id = cycle.tenant_id
          AND agent.actor_id = cycle.owner_actor_id
          AND agent.id = cycle.agent_id
        JOIN LATERAL public.omni_resolve_moltbook_owner_membership_v1(
          cycle.tenant_id,
          cycle.owner_actor_id
        ) owner_membership
          ON owner_membership.canonical_actor_id = principal.controller_actor_id
          AND owner_membership.canonical_actor_id =
            enrollment.authorized_by_actor_id
        WHERE cycle.tenant_id = ${authority.tenantId}
          AND cycle.owner_actor_id = ${authority.ownerActorId}
          AND cycle.id = ${authority.cycleId}
          AND cycle.connection_id = ${authority.connectionId}
          AND cycle.enrollment_id = ${authority.enrollmentId}
          AND cycle.enrollment_version = ${authority.enrollmentVersion}
          AND cycle.authority_version = ${authority.authorityVersion}
          AND cycle.execution_purpose = ${MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE}
          AND cycle.correlation_id = ${authority.cycleId}
          AND cycle.lease_token_sha256 = ${leaseSha}
          AND cycle.lease_expires_at > ${nowIso}
          AND cycle.status = 'running'
          AND cycle.agent_run_id = ${agentRunId}
          AND cycle.agent_id = ${authority.agentId}
          AND cycle.membership_role = ${authority.membershipRole}
          AND enrollment.status = 'enabled'
          AND connection.status = 'claimed'
          AND connection.claim_state = 'claimed'
          AND exact_authority.agent_id = ${authority.agentId}
          AND exact_authority.principal_id = ${authority.principalId}
          AND exact_authority.principal_generation = ${authority.principalGeneration}
          AND exact_authority.principal_sha256 = ${authority.principalSha256}
          AND exact_authority.definition_version = ${authority.definitionVersion}
          AND exact_authority.definition_sha256 = ${authority.definitionSha256}
          AND exact_authority.policy_boundary_sha256 = ${authority.policyBoundarySha256}
          AND principal.principal_kind = 'agent'
          AND principal.agent_definition_id = ${authority.agentId}
          AND principal.controller_actor_id = ${authority.canonicalActorId}
          AND principal.state = 'active'
          AND policy.owner_actor_id = principal.controller_actor_id
          AND policy.agent_definition_id = ${authority.agentId}
          AND policy.agent_definition_version = ${authority.definitionVersion}
          AND policy.authority_mode = 'explicit_grants'
          AND (policy.expires_at IS NULL OR policy.expires_at > ${nowIso})
          AND agent.status IN ('ready', 'learning')
          AND exact_authority.definition_version = (
            SELECT MAX(current_definition.definition_version)
            FROM omni_agent_definition_versions current_definition
            WHERE current_definition.tenant_id = cycle.tenant_id
              AND current_definition.agent_definition_id = cycle.agent_id
          )
          AND cardinality(policy.context_grant_ids) = 0
          AND cardinality(policy.capability_grant_ids) = 0
          AND owner_membership.canonical_actor_id = ${authority.canonicalActorId}
          AND owner_membership.auth_user_id = ${authority.authUserId}
          AND owner_membership.membership_role = ${authority.membershipRole}
          AND omni_moltbook_agent_boundary_is_exact_v1(
            agent.skill_ids, agent.tool_ids, agent.memory_scope,
            agent.autonomy, agent.approval_policy
          )
          AND omni_moltbook_agent_boundary_is_exact_v1(
            ARRAY[]::text[], policy.tool_grant_ids, policy.memory_scope,
            policy.autonomy, policy.approval_policy
          )
          AND enrollment.authority_version = (
            SELECT MAX(current_authority.authority_version)
            FROM omni_moltbook_authority_versions current_authority
            WHERE current_authority.tenant_id = cycle.tenant_id
              AND current_authority.owner_actor_id = cycle.owner_actor_id
              AND current_authority.connection_id = cycle.connection_id
        )
        LIMIT 1
        FOR UPDATE OF cycle, enrollment, connection, principal
      `;
      const cycle = cycleRows[0];
      if (!cycle) leaseMismatch();
      const existingRows = await sql`
        SELECT * FROM omni_moltbook_autonomy_action_claims
        WHERE tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.ownerActorId}
          AND connection_id = ${authority.connectionId}
          AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      if (existingRows[0]) {
        return actionAuthorizationFromExactExisting(existingRows[0], {
          authority, toolId, toolInputSha256, effectTargetId,
          idempotencyKey, toolExecutionId, agentRunId,
        });
      }
      const { kind } = actionKindForTool(toolId);
      const counts = await sql`
        SELECT
          count(*) FILTER (
            WHERE cycle_id = ${authority.cycleId}
          )::int AS cycle_count,
          count(*) FILTER (
            WHERE action_kind = ${kind}
              AND claimed_at >= ${new Date(now.getTime() - 86_400_000).toISOString()}
          )::int AS daily_count,
          max(claimed_at) AS last_claimed_at
        FROM omni_moltbook_autonomy_action_claims
        WHERE tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.ownerActorId}
          AND connection_id = ${authority.connectionId}
      `;
      const count = counts[0] || {};
      const dailyLimit = Number(cycle[`daily_${kind}_limit`]);
      // Initial rollout is deliberately narrower than the stored category
      // ceilings: exactly one public mutation of any kind per cycle.
      if (Number(count.cycle_count || 0) >= 1 || Number(count.daily_count || 0) >= dailyLimit) {
        throw new MoltbookAutonomyStoreError(
          `The ${kind} autonomy budget is exhausted.`,
          "budget_exhausted",
        );
      }
      const lastClaimedAt = optionalIso(count.last_claimed_at);
      if (
        lastClaimedAt &&
        new Date(lastClaimedAt).getTime() > now.getTime() - MOLTBOOK_AUTONOMY_ACTION_COOLDOWN_MS
      ) {
        throw new MoltbookAutonomyStoreError(
          `The ${kind} autonomy cooldown is still active.`,
          "cooldown_active",
        );
      }
      const claimId = opaqueId("moltbook_action");
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
      const claimTokenSha256 = sha256(randomBytes(32).toString("hex"));
      const inserted = await sql`
        INSERT INTO omni_moltbook_autonomy_action_claims (
          id, tenant_id, owner_actor_id, agent_id, connection_id,
          enrollment_id, cycle_id, agent_run_id, authority_version, execution_purpose,
          correlation_id, action_kind, tool_id, tool_input_sha256,
          effect_target_id, idempotency_key, claim_token_sha256, status,
          claimed_at, expires_at, tool_execution_id, consumed_at, created_at
        ) VALUES (
          ${claimId}, ${authority.tenantId}, ${authority.ownerActorId},
          ${authority.agentId}, ${authority.connectionId}, ${authority.enrollmentId},
          ${authority.cycleId}, ${agentRunId}, ${authority.authorityVersion},
          ${MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE}, ${authority.cycleId}, ${kind},
          ${toolId}, ${toolInputSha256}, ${effectTargetId}, ${idempotencyKey},
          ${claimTokenSha256}, 'consumed', ${nowIso}, ${expiresAt},
          ${toolExecutionId}, ${nowIso}, ${nowIso}
        ) RETURNING *
      `;
      const row = exactlyOne(inserted, "Moltbook autonomy action authorization");
      await appendEvent(sql, {
        owner: { tenantId: authority.tenantId, actorId: authority.ownerActorId },
        agentId: authority.agentId,
        connectionId: authority.connectionId,
        enrollmentId: authority.enrollmentId,
        cycleId: authority.cycleId,
        actionClaimId: claimId,
        eventType: "moltbook.autonomy.action.consumed",
        payload: {
          claimId, toolId, toolInputSha256, effectTargetId,
          idempotencyKey, toolExecutionId, agentRunId,
        },
        createdAt: nowIso,
      });
      return actionAuthorizationFromRow(row, false);
    }) as Promise<MoltbookAutonomyActionAuthorization>,
  );
}

export const claimMoltbookAutonomyAction = authorizeMoltbookAutonomyAction;

export async function updateMoltbookInterests(input: {
  authority: MoltbookAutonomyCycleAuthority;
  leaseToken: string;
  observations: readonly Readonly<{
    topic: string;
    score: number;
    confidence: number;
    active?: boolean;
    evidenceSha256s: readonly string[];
  }>[];
}): Promise<readonly MoltbookInterestProjection[]> {
  const authority = exactCycleAuthority(input.authority);
  const leaseSha = sha256(requiredSecret(input.leaseToken, "cycle lease token"));
  if (!input.observations.length || input.observations.length > 32) {
    invalid("An interest update requires between 1 and 32 observations.");
  }
  const seen = new Set<string>();
  const observations = input.observations.map((observation) => {
    const topic = normalizeInterestTopic(observation.topic);
    if (seen.has(topic)) invalid("An interest update cannot repeat a topic.");
    seen.add(topic);
    const evidence = [...new Set(observation.evidenceSha256s.map((item) =>
      digest(item, "interest evidence")
    ))];
    if (!evidence.length || evidence.length > 8) {
      invalid("Interest evidence must contain between 1 and 8 digests.");
    }
    if (!isUnitNumber(observation.score) || !isUnitNumber(observation.confidence)) {
      invalid("Interest score and confidence must be between zero and one.");
    }
    return Object.freeze({
      topic,
      score: observation.score,
      confidence: observation.confidence,
      active: observation.active !== false,
      evidenceSha256s: evidence,
    });
  });
  await databaseReady();
  return runWithDatabaseActorScope(
    authority.tenantId,
    [authority.canonicalActorId, authority.ownerActorId],
    () =>
    getSql().transaction(async (sql: Sql) => {
      await advisoryLock(sql, `moltbook-interests:${authority.tenantId}:${authority.connectionId}`);
      const now = new Date().toISOString();
      const cycleRows = await sql`
        SELECT id FROM omni_moltbook_autonomy_cycles
        WHERE tenant_id = ${authority.tenantId}
          AND owner_actor_id = ${authority.ownerActorId}
          AND id = ${authority.cycleId}
          AND connection_id = ${authority.connectionId}
          AND enrollment_id = ${authority.enrollmentId}
          AND authority_version = ${authority.authorityVersion}
          AND lease_token_sha256 = ${leaseSha}
          AND lease_expires_at > ${now}
          AND status = 'running'
        LIMIT 1
        FOR UPDATE
      `;
      if (cycleRows.length !== 1) leaseMismatch();
      for (const observation of observations) {
        const existing = await sql`
          SELECT * FROM omni_moltbook_interest_observations
          WHERE tenant_id = ${authority.tenantId}
            AND owner_actor_id = ${authority.ownerActorId}
            AND cycle_id = ${authority.cycleId}
            AND topic = ${observation.topic}
          LIMIT 1
        `;
        if (existing[0]) {
          if (!interestObservationMatches(existing[0], observation)) {
            throw new MoltbookAutonomyStoreError(
              "A different interest observation already exists for this cycle and topic.",
              "conflict",
            );
          }
          continue;
        }
        await sql`
          INSERT INTO omni_moltbook_interest_observations (
            id, tenant_id, owner_actor_id, agent_id, connection_id, cycle_id,
            topic, score, confidence, active, evidence_sha256s, created_at
          ) VALUES (
            ${opaqueId("moltbook_interest")}, ${authority.tenantId},
            ${authority.ownerActorId}, ${authority.agentId}, ${authority.connectionId},
            ${authority.cycleId}, ${observation.topic}, ${observation.score},
            ${observation.confidence}, ${observation.active},
            ${observation.evidenceSha256s}, ${now}
          )
        `;
      }
      await appendEvent(sql, {
        owner: { tenantId: authority.tenantId, actorId: authority.ownerActorId },
        agentId: authority.agentId,
        connectionId: authority.connectionId,
        enrollmentId: authority.enrollmentId,
        cycleId: authority.cycleId,
        eventType: "moltbook.autonomy.interests.updated",
        payload: {
          cycleId: authority.cycleId,
          observations: observations.map((item) => ({
            topic: item.topic,
            score: item.score,
            confidence: item.confidence,
            active: item.active,
            evidenceSha256s: item.evidenceSha256s,
          })),
        },
        createdAt: now,
      });
      return readInterestProjection(
        sql,
        { tenantId: authority.tenantId, actorId: authority.ownerActorId },
        authority.connectionId,
      );
    }) as Promise<readonly MoltbookInterestProjection[]>,
  );
}

async function transitionEnrollment(
  input: { owner: MoltbookAutonomyOwner; agentId: string },
  status: "enabled" | "paused" | "revoked",
) {
  const owner = exactOwner(input.owner);
  const agentId = requiredId(input.agentId, 240, "Agent id");
  await databaseReady();
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], () =>
    getSql().transaction(async (sql: Sql) => {
      const now = new Date().toISOString();
      const currentRows = await sql`
        SELECT * FROM omni_moltbook_autonomy_enrollments
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND agent_id = ${agentId}
          AND status <> 'revoked'
        ORDER BY enrollment_version DESC
        LIMIT 1
        FOR UPDATE
      `;
      const current = exactlyOne(currentRows, "active Moltbook autonomy enrollment");
      if (String(current.status) === status) return enrollmentFromRow(current);
      const rows = await sql`
        UPDATE omni_moltbook_autonomy_enrollments
        SET status = ${status},
            last_paused_at = CASE WHEN ${status} = 'paused' THEN ${now} ELSE last_paused_at END,
            last_resumed_at = CASE WHEN ${status} = 'enabled' THEN ${now} ELSE last_resumed_at END,
            revoked_at = CASE WHEN ${status} = 'revoked' THEN ${now} ELSE revoked_at END,
            next_cycle_at = CASE WHEN ${status} = 'enabled' THEN ${now} ELSE next_cycle_at END,
            updated_at = ${now}
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.actorId}
          AND id = ${String(current.id)}
          AND status = ${String(current.status)}
        RETURNING *
      `;
      const next = enrollmentFromRow(exactlyOne(rows, "Moltbook autonomy enrollment transition"));
      await appendEvent(sql, {
        owner,
        agentId,
        connectionId: next.connectionId,
        enrollmentId: next.id,
        eventType: `moltbook.autonomy.enrollment.${status === "enabled" ? "resumed" : status}`,
        payload: { id: next.id, status },
        createdAt: now,
      });
      return next;
    }) as Promise<MoltbookAutonomyEnrollmentProjection>
  );
}

async function recoverExpiredMoltbookCycles(sql: Sql, input: {
  tenantId: string;
  ownerActorId?: string;
  nowIso: string;
}) {
  const expiredRows = await sql`
    UPDATE omni_moltbook_autonomy_cycles
    SET status = 'failed', completed_at = ${input.nowIso},
        error_code = 'lease_expired', updated_at = ${input.nowIso}
    WHERE status IN ('claimed', 'running')
      AND lease_expires_at <= ${input.nowIso}
      AND tenant_id = ${input.tenantId}
      AND (${input.ownerActorId || null}::text IS NULL
        OR owner_actor_id = ${input.ownerActorId || null})
    RETURNING tenant_id, owner_actor_id, agent_id, connection_id,
              enrollment_id, id AS cycle_id
  `;
  const affectedEnrollments = new Map<string, SqlRow>();
  for (const row of expiredRows) {
    const owner = {
      tenantId: String(row.tenant_id),
      actorId: String(row.owner_actor_id),
    };
    await appendEvent(sql, {
      owner,
      agentId: String(row.agent_id),
      connectionId: String(row.connection_id),
      enrollmentId: String(row.enrollment_id),
      cycleId: String(row.cycle_id),
      eventType: "moltbook.autonomy.cycle.completed",
      payload: {
        cycleId: String(row.cycle_id),
        status: "failed",
        errorCode: "lease_expired",
      },
      createdAt: input.nowIso,
    });
    affectedEnrollments.set([
      owner.tenantId,
      owner.actorId,
      String(row.enrollment_id),
    ].join(":"), row);
  }
  for (const row of affectedEnrollments.values()) {
    const latestRows = await sql`
      SELECT status
      FROM omni_moltbook_autonomy_cycles
      WHERE tenant_id = ${String(row.tenant_id)}
        AND owner_actor_id = ${String(row.owner_actor_id)}
        AND enrollment_id = ${String(row.enrollment_id)}
      ORDER BY created_at DESC, id DESC
      LIMIT 3
    `;
    if (
      latestRows.length !== 3 ||
      latestRows.some((latest) => latest.status !== "failed")
    ) {
      continue;
    }
    const paused = await sql`
      UPDATE omni_moltbook_autonomy_enrollments
      SET status = 'paused', last_paused_at = ${input.nowIso},
          updated_at = ${input.nowIso}
      WHERE tenant_id = ${String(row.tenant_id)}
        AND owner_actor_id = ${String(row.owner_actor_id)}
        AND id = ${String(row.enrollment_id)}
        AND status = 'enabled'
      RETURNING id
    `;
    if (!paused.length) continue;
    await appendEvent(sql, {
      owner: {
        tenantId: String(row.tenant_id),
        actorId: String(row.owner_actor_id),
      },
      agentId: String(row.agent_id),
      connectionId: String(row.connection_id),
      enrollmentId: String(row.enrollment_id),
      eventType: "moltbook.autonomy.enrollment.paused",
      payload: {
        enrollmentId: String(row.enrollment_id),
        reason: "three_consecutive_failed_cycles",
      },
      createdAt: input.nowIso,
    });
  }
}

async function readInterestProjection(
  sql: Sql,
  owner: MoltbookAutonomyOwner,
  connectionId: string,
): Promise<readonly MoltbookInterestProjection[]> {
  const rows = await sql`
    SELECT topic, score, confidence, evidence_sha256s, created_at
    FROM (
      SELECT DISTINCT ON (topic)
        topic, score, confidence, active, evidence_sha256s, created_at, id
      FROM omni_moltbook_interest_observations
      WHERE tenant_id = ${owner.tenantId}
        AND owner_actor_id = ${owner.actorId}
        AND connection_id = ${connectionId}
      ORDER BY topic, created_at DESC, id DESC
    ) latest
    WHERE active
    ORDER BY score DESC, confidence DESC, topic ASC
    LIMIT 32
  `;
  return rows.map((row) => Object.freeze({
    topic: String(row.topic),
    score: Number(row.score),
    confidence: Number(row.confidence),
    evidenceSha256s: Object.freeze(stringArray(row.evidence_sha256s)),
    observedAt: iso(row.created_at),
  }));
}

async function appendEvent(sql: Sql, input: {
  owner: MoltbookAutonomyOwner;
  agentId: string;
  connectionId: string;
  eventType: string;
  enrollmentId?: string;
  cycleId?: string;
  actionClaimId?: string;
  payload: unknown;
  createdAt: string;
}) {
  const payloadSha256 = sha256(stableJson(input.payload));
  const eventId = `moltbook_event_${sha256([
    input.owner.tenantId,
    input.owner.actorId,
    input.connectionId,
    input.eventType,
    input.enrollmentId || "",
    input.cycleId || "",
    input.actionClaimId || "",
    payloadSha256,
    input.createdAt,
  ].join(":")).slice(0, 48)}`;
  await sql`
    INSERT INTO omni_moltbook_autonomy_events (
      id, tenant_id, owner_actor_id, agent_id, connection_id, event_type,
      enrollment_id, cycle_id, action_claim_id, payload_sha256, created_at
    ) VALUES (
      ${eventId}, ${input.owner.tenantId}, ${input.owner.actorId},
      ${input.agentId}, ${input.connectionId}, ${input.eventType},
      ${input.enrollmentId || null}, ${input.cycleId || null},
      ${input.actionClaimId || null}, ${payloadSha256}, ${input.createdAt}
    ) ON CONFLICT (id) DO NOTHING
  `;
}

function authorityFromRow(row: SqlRow): MoltbookAuthorityVersionProjection {
  return Object.freeze({
    id: String(row.id),
    connectionId: String(row.connection_id),
    agentId: String(row.agent_id),
    authorityVersion: safePositive(row.authority_version, "authority version"),
    principalId: String(row.principal_id),
    principalGeneration: safePositive(row.principal_generation, "principal generation"),
    principalSha256: String(row.principal_sha256),
    definitionVersion: safePositive(row.definition_version, "definition version"),
    definitionSha256: String(row.definition_sha256),
    policyBoundarySha256: String(row.policy_boundary_sha256),
    changeReason: row.change_reason === "initial_connection"
      ? "initial_connection"
      : "agent_rebind",
    changeRequestSha256: String(row.change_request_sha256),
    createdAt: iso(row.created_at),
  });
}

function enrollmentFromRow(row: SqlRow): MoltbookAutonomyEnrollmentProjection {
  return Object.freeze({
    id: String(row.id),
    connectionId: String(row.connection_id),
    agentId: String(row.agent_id),
    enrollmentVersion: safePositive(row.enrollment_version, "enrollment version"),
    authorityVersion: safePositive(row.authority_version, "authority version"),
    status: requiredEnrollmentStatus(row.status),
    charterSha256: String(row.charter_sha256),
    budgets: Object.freeze({
      cycleIntervalSeconds: Number(row.cycle_interval_seconds),
      cycle: Object.freeze({
        posts: Number(row.cycle_post_limit),
        comments: Number(row.cycle_comment_limit),
        votes: Number(row.cycle_vote_limit),
        follows: Number(row.cycle_follow_limit),
        subscriptions: Number(row.cycle_subscribe_limit),
      }),
      daily: Object.freeze({
        posts: Number(row.daily_post_limit),
        comments: Number(row.daily_comment_limit),
        votes: Number(row.daily_vote_limit),
        follows: Number(row.daily_follow_limit),
        subscriptions: Number(row.daily_subscribe_limit),
      }),
    }),
    nextCycleAt: iso(row.next_cycle_at),
    lastCycleAt: optionalIso(row.last_cycle_at),
    enabledAt: iso(row.enabled_at),
    lastPausedAt: optionalIso(row.last_paused_at),
    lastResumedAt: optionalIso(row.last_resumed_at),
    revokedAt: optionalIso(row.revoked_at),
  });
}

function actionAuthorizationFromExactExisting(
  row: SqlRow,
  expected: {
    authority: MoltbookAutonomyCycleAuthority;
    toolId: MoltbookAutonomyMutationToolId;
    toolInputSha256: string;
    effectTargetId: string;
    idempotencyKey: string;
    toolExecutionId: string;
    agentRunId: string;
  },
) {
  if (
    row.status !== "consumed" ||
    row.cycle_id !== expected.authority.cycleId ||
    row.enrollment_id !== expected.authority.enrollmentId ||
    Number(row.authority_version) !== expected.authority.authorityVersion ||
    row.execution_purpose !== expected.authority.executionPurpose ||
    row.correlation_id !== expected.authority.correlationId ||
    row.tool_id !== expected.toolId ||
    row.tool_input_sha256 !== expected.toolInputSha256 ||
    row.effect_target_id !== expected.effectTargetId ||
    row.idempotency_key !== expected.idempotencyKey ||
    row.tool_execution_id !== expected.toolExecutionId ||
    row.agent_run_id !== expected.agentRunId
  ) {
    throw new MoltbookAutonomyStoreError(
      "Moltbook autonomy idempotency evidence conflicts with this action.",
      "conflict",
    );
  }
  return actionAuthorizationFromRow(row, true);
}

function actionAuthorizationFromRow(
  row: SqlRow,
  reused: boolean,
): MoltbookAutonomyActionAuthorization {
  return Object.freeze({
    claimId: String(row.id),
    cycleId: String(row.cycle_id),
    agentRunId: String(row.agent_run_id),
    toolId: actionKindForTool(String(row.tool_id) as MoltbookAutonomyMutationToolId).toolId,
    toolInputSha256: String(row.tool_input_sha256),
    effectTargetId: String(row.effect_target_id),
    idempotencyKey: String(row.idempotency_key),
    toolExecutionId: String(row.tool_execution_id),
    claimedAt: iso(row.claimed_at),
    consumedAt: iso(row.consumed_at),
    reused,
  });
}

function actionKindForTool(toolId: MoltbookAutonomyMutationToolId) {
  const mapping: Record<MoltbookAutonomyMutationToolId, "post" | "comment" | "vote" | "follow" | "subscribe"> = {
    "moltbook.post.create": "post",
    "moltbook.comment.create": "comment",
    "moltbook.post.vote": "vote",
    "moltbook.comment.upvote": "vote",
    "moltbook.agent.follow": "follow",
    "moltbook.submolt.subscribe": "subscribe",
  };
  const kind = mapping[toolId];
  if (!kind) invalid("This Moltbook tool is not standing-authorizable.");
  return { toolId, kind } as const;
}

function exactOwner(owner: MoltbookAutonomyOwner) {
  return Object.freeze({
    tenantId: requiredId(owner.tenantId, 160, "tenant id"),
    actorId: requiredId(owner.actorId, 320, "owner actor id"),
  });
}

const exactOwnerValue = exactOwner;

function exactPin(pin: MoltbookAuthorityPin): MoltbookAuthorityPin {
  return Object.freeze({
    agentId: requiredId(pin.agentId, 240, "Agent id"),
    principalId: requiredId(pin.principalId, 240, "principal id"),
    principalGeneration: safePositive(pin.principalGeneration, "principal generation"),
    principalSha256: digest(pin.principalSha256, "principal"),
    definitionVersion: safePositive(pin.definitionVersion, "definition version"),
    definitionSha256: digest(pin.definitionSha256, "definition"),
    policyBoundarySha256: digest(pin.policyBoundarySha256, "policy boundary"),
  });
}

function exactCycleAuthority(
  authority: MoltbookAutonomyCycleAuthority,
): MoltbookAutonomyCycleAuthority {
  const pin = exactPin(authority);
  const cycleId = requiredId(authority.cycleId, 80, "cycle id");
  if (
    authority.executionPurpose !== MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE ||
    authority.correlationId !== cycleId
  ) {
    throw new MoltbookAutonomyStoreError(
      "Moltbook autonomy cycle execution scope is invalid.",
      "stale_authority",
    );
  }
  return Object.freeze({
    ...pin,
    tenantId: requiredId(authority.tenantId, 160, "tenant id"),
    ownerActorId: requiredId(authority.ownerActorId, 320, "owner actor id"),
    canonicalActorId: requiredId(authority.canonicalActorId, 320, "canonical actor id"),
    authUserId: requiredId(authority.authUserId, 80, "auth user id"),
    membershipRole: requiredMembershipRole(authority.membershipRole),
    connectionId: requiredId(authority.connectionId, 80, "connection id"),
    enrollmentId: requiredId(authority.enrollmentId, 80, "enrollment id"),
    enrollmentVersion: safePositive(authority.enrollmentVersion, "enrollment version"),
    authorityVersion: safePositive(authority.authorityVersion, "authority version"),
    cycleId,
    executionPurpose: MOLTBOOK_AUTONOMY_EXECUTION_PURPOSE,
    correlationId: cycleId,
  });
}

export function normalizeInterestTopic(value: string) {
  const topic = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!MOLTBOOK_INTEREST_TOPIC_SET.has(topic)) {
    invalid("Interest topics must use the reviewed category taxonomy.");
  }
  return topic;
}

export function validateMoltbookAutonomyBudgets(
  value: MoltbookAutonomyBudgets,
) {
  return exactBudgets(value);
}

function exactBudgets(value: MoltbookAutonomyBudgets): MoltbookAutonomyBudgets {
  const integer = (candidate: number, min: number, max: number, name: string) => {
    if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
      invalid(`${name} is outside the safe Moltbook autonomy limit.`);
    }
    return candidate;
  };
  return Object.freeze({
    cycleIntervalSeconds: integer(value.cycleIntervalSeconds, 14_400, 86_400, "cycle interval"),
    cycle: Object.freeze({
      posts: integer(value.cycle.posts, 0, 1, "cycle post budget"),
      comments: integer(value.cycle.comments, 0, 2, "cycle comment budget"),
      votes: integer(value.cycle.votes, 0, 4, "cycle vote budget"),
      follows: integer(value.cycle.follows, 0, 1, "cycle follow budget"),
      subscriptions: integer(value.cycle.subscriptions, 0, 1, "cycle subscription budget"),
    }),
    daily: Object.freeze({
      posts: integer(value.daily.posts, 0, 1, "daily post budget"),
      comments: integer(value.daily.comments, 0, 6, "daily comment budget"),
      votes: integer(value.daily.votes, 0, 12, "daily vote budget"),
      follows: integer(value.daily.follows, 0, 2, "daily follow budget"),
      subscriptions: integer(value.daily.subscriptions, 0, 2, "daily subscription budget"),
    }),
  });
}

function pinsEqual(left: MoltbookAuthorityPin, right: MoltbookAuthorityPin) {
  return left.agentId === right.agentId &&
    left.principalId === right.principalId &&
    left.principalGeneration === right.principalGeneration &&
    left.principalSha256 === right.principalSha256 &&
    left.definitionVersion === right.definitionVersion &&
    left.definitionSha256 === right.definitionSha256 &&
    left.policyBoundarySha256 === right.policyBoundarySha256;
}

function interestObservationMatches(
  row: SqlRow,
  observation: {
    score: number;
    confidence: number;
    active: boolean;
    evidenceSha256s: readonly string[];
  },
) {
  return Number(row.score) === observation.score &&
    Number(row.confidence) === observation.confidence &&
    Boolean(row.active) === observation.active &&
    stableJson(stringArray(row.evidence_sha256s)) === stableJson(observation.evidenceSha256s);
}

async function advisoryLock(sql: Sql, key: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function databaseReady() {
  if (!hasDatabaseUrl()) {
    throw new MoltbookAutonomyStoreError(
      "Moltbook autonomy requires durable database storage.",
      "database_required",
    );
  }
  await ensureDatabaseSchema();
}

function requiredId(value: unknown, max: number, name: string) {
  if (typeof value !== "string") invalid(`A valid ${name} is required.`);
  const result = value.trim();
  if (!result || result.length > max || result.includes("\0")) {
    invalid(`A valid ${name} is required.`);
  }
  return result;
}

function requiredSecret(value: unknown, name: string) {
  const result = requiredId(value, 256, name);
  if (result.length < 32) invalid(`A valid ${name} is required.`);
  return result;
}

function requiredTarget(value: unknown) {
  const result = requiredId(value, 240, "effect target id");
  if (!/^moltbook_target_[a-f0-9]{52,64}$/.test(result)) {
    invalid("Autonomy actions require a canonical Moltbook effect target digest.");
  }
  return result;
}

function requiredErrorCode(value: unknown) {
  const result = requiredId(value, 80, "error code");
  if (!/^[a-z0-9_.:-]{1,80}$/.test(result)) invalid("Invalid error code.");
  return result;
}

function digest(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalid(`A valid ${name} digest is required.`);
  }
  return value;
}

function opaqueId(prefix: string) {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactlyOne(rows: SqlRow[], name: string) {
  if (rows.length !== 1) {
    throw new MoltbookAutonomyStoreError(`${name} was not found.`, "not_found");
  }
  return rows[0];
}

function exactlyOneString(rows: SqlRow[], key: string, name: string) {
  const row = exactlyOne(rows, name);
  return requiredId(row[key], 320, name);
}

function safePositive(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) invalid(`Invalid ${name}.`);
  return result;
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) invalid("Stored Moltbook autonomy time is invalid.");
  return date.toISOString();
}

function optionalIso(value: unknown) {
  return value === null || value === undefined ? undefined : iso(value);
}

function optionalString(value: unknown) {
  return value === null || value === undefined ? undefined : String(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid("Stored Moltbook autonomy digest evidence is invalid.");
  }
  return [...value] as string[];
}

function requiredEnrollmentStatus(value: unknown) {
  if (value === "enabled" || value === "paused" || value === "revoked") return value;
  return invalid("Stored Moltbook autonomy enrollment status is invalid.");
}

function requiredCycleStatus(value: unknown) {
  if (value === "claimed" || value === "running" || value === "succeeded" || value === "failed") return value;
  return invalid("Stored Moltbook autonomy cycle status is invalid.");
}

function requiredMembershipRole(value: unknown): "operator" | "admin" {
  if (value === "operator" || value === "admin") return value;
  return invalid("Moltbook autonomy requires an active operator or admin membership.");
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function leaseMismatch(): never {
  throw new MoltbookAutonomyStoreError(
    "The Moltbook autonomy cycle lease is missing, expired, or stale.",
    "lease_mismatch",
  );
}

function invalid(message: string): never {
  throw new MoltbookAutonomyStoreError(message, "invalid_input");
}
