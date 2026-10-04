import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  PERSONAL_CONTEXT_CONSENT_CONTRACT_ID,
  PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION,
  PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
  PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION,
  PERSONAL_CONTEXT_NOTICE_SHA256,
  buildPersonalContextConsentAuthorityV1,
  personalContextConsentAuthorityV1Schema,
  personalContextConsentStatus,
  personalContextConsentNotice,
  type PersonalContextConsentAuthorityV1,
  type PersonalContextConsentStatusV1,
} from "@/lib/memory/personal-context-consent";
import {
  PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT,
  PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT,
  PERSONAL_CONTEXT_CONSENT_NATIVE_READ_CONTRACT,
  PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE,
  PersonalContextConsentNativeError,
  personalContextConsentNativeAcceptanceId,
  personalContextConsentNativeAcceptanceSchema,
  personalContextConsentNativeCurrentSchema,
  personalContextConsentNativeDecisionToken,
  personalContextConsentNativeIntent,
  personalContextConsentNativeStateSchema,
  personalContextConsentNativeTokensEqual,
  type PersonalContextConsentNativeAcceptance,
  type PersonalContextConsentNativeCurrent,
  type PersonalContextConsentNativeRequest,
  type PersonalContextConsentNativeState,
} from "@/lib/memory/personal-context-consent-native-contracts";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export const PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE =
  "memory.personal_context_consent.manage" as const;
export const PERSONAL_CONTEXT_CONSENT_EVENT_TYPES = Object.freeze({
  activated: "memory.personal_context_consent.activated",
  revoked: "memory.personal_context_consent.revoked",
} as const);

type ConsentRow = Record<string, unknown>;
type ConsentSql = ReturnType<typeof getSql>;

export class PersonalContextConsentError extends Error {
  readonly code:
    | "invalid_authority"
    | "postgres_required"
    | "inactive"
    | "transition_failed";

  constructor(code: PersonalContextConsentError["code"], message: string) {
    super(message);
    this.name = "PersonalContextConsentError";
    this.code = code;
  }
}

export async function getPersonalContextConsentStatus(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
}): Promise<PersonalContextConsentStatusV1> {
  assertAuthorityInput(input);
  if (!hasDatabaseUrl()) return personalContextConsentStatus(null);
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    input.actorBinding.readableOwnerActorIds,
    async () => personalContextConsentStatus(
      await readActiveAuthority(getSql(), input),
    ),
  );
}

export async function requireActivePersonalContextConsent(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
  expectedAuthoritySha256?: string;
}): Promise<PersonalContextConsentAuthorityV1> {
  assertAuthorityInput(input);
  if (!hasDatabaseUrl()) {
    throw new PersonalContextConsentError(
      "postgres_required",
      "Personal-context consent requires durable storage.",
    );
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    input.actorBinding.readableOwnerActorIds,
    async () => {
      const authority = await readActiveAuthority(getSql(), input);
      if (
        !authority ||
        input.expectedAuthoritySha256 &&
          authority.authoritySha256 !== input.expectedAuthoritySha256
      ) {
        throw new PersonalContextConsentError(
          "inactive",
          "Personal automatic context is not currently authorized.",
        );
      }
      return authority;
    },
  );
}

export async function activatePersonalContextConsent(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
  noticeSha256: string;
}): Promise<PersonalContextConsentStatusV1> {
  assertMutationAuthority(input);
  if (input.noticeSha256 !== PERSONAL_CONTEXT_NOTICE_SHA256) {
    throw new PersonalContextConsentError(
      "invalid_authority",
      "The personal-context notice is stale.",
    );
  }
  if (!hasDatabaseUrl()) {
    throw new PersonalContextConsentError(
      "postgres_required",
      "Personal-context consent requires durable storage.",
    );
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    input.actorBinding.readableOwnerActorIds,
    async () => {
      try {
        const status = await getSql().transaction(async (sql: ConsentSql) => {
          await lockConsentAuthority(sql, input.tenantId, input.actorBinding.canonicalActorId);
          const existing = await readActiveAuthority(sql, input);
          if (existing) return personalContextConsentStatus(existing);

          const generationRows = await sql`
            SELECT COALESCE(MAX(consent_generation), 0) + 1 AS next_generation
            FROM omni_personal_context_consents
            WHERE tenant_id = ${input.tenantId}
              AND actor_id = ${input.actorBinding.canonicalActorId}
          `;
          const generation = positiveSafeInteger(
            generationRows[0]?.next_generation,
          );
          if (!generation) throw new Error("invalid consent generation");

          const rows = await sql`
            INSERT INTO omni_personal_context_consents (
              tenant_id,
              actor_id,
              consent_generation,
              state,
              lifecycle_revision,
              activated_by_actor_id
            ) VALUES (
              ${input.tenantId},
              ${input.actorBinding.canonicalActorId},
              ${generation},
              'active',
              1,
              ${input.actorBinding.canonicalActorId}
            )
            RETURNING *
          `;
          const authority = authorityFromRow(onlyRow(rows), input);
          await appendConsentEvent({
            sql,
            executionScope: input.executionScope,
            authority,
            type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.activated,
            lifecycleRevision: 1,
          });
          return personalContextConsentStatus(authority);
        });
        return status as PersonalContextConsentStatusV1;
      } catch (error) {
        if (error instanceof PersonalContextConsentError) throw error;
        throw new PersonalContextConsentError(
          "transition_failed",
          "Personal-context consent could not be activated.",
        );
      }
    },
  );
}

export async function revokePersonalContextConsent(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
}): Promise<PersonalContextConsentStatusV1> {
  assertMutationAuthority(input);
  if (!hasDatabaseUrl()) {
    throw new PersonalContextConsentError(
      "postgres_required",
      "Personal-context consent requires durable storage.",
    );
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.tenantId,
    input.actorBinding.readableOwnerActorIds,
    async () => {
      try {
        const status = await getSql().transaction(async (sql: ConsentSql) => {
          await lockConsentAuthority(sql, input.tenantId, input.actorBinding.canonicalActorId);
          const existing = await readActiveAuthority(sql, input);
          if (!existing) return personalContextConsentStatus(null);

          const rows = await sql`
            UPDATE omni_personal_context_consents
            SET
              state = 'revoked',
              lifecycle_revision = 2,
              revoked_by_actor_id = ${input.actorBinding.canonicalActorId}
            WHERE tenant_id = ${input.tenantId}
              AND actor_id = ${input.actorBinding.canonicalActorId}
              AND consent_generation = ${existing.consentGeneration}
              AND state = 'active'
              AND lifecycle_revision = 1
            RETURNING *
          `;
          const row = onlyRow(rows);
          if (!row || row.state !== "revoked") {
            throw new Error("consent revocation lost its revision fence");
          }
          await appendConsentEvent({
            sql,
            executionScope: input.executionScope,
            authority: existing,
            type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.revoked,
            lifecycleRevision: 2,
          });
          return personalContextConsentStatus(null);
        });
        return status as PersonalContextConsentStatusV1;
      } catch (error) {
        if (error instanceof PersonalContextConsentError) throw error;
        throw new PersonalContextConsentError(
          "transition_failed",
          "Personal-context consent could not be revoked.",
        );
      }
    },
  );
}

async function readActiveAuthority(
  sql: ConsentSql,
  input: {
    tenantId: string;
    actorBinding: CanonicalRequestActorBindingV1;
  },
) {
  const rows = await sql`
    SELECT *
    FROM omni_personal_context_consents
    WHERE tenant_id = ${input.tenantId}
      AND actor_id = ${input.actorBinding.canonicalActorId}
      AND state = 'active'
    ORDER BY consent_generation DESC
    LIMIT 2
  `;
  if (rows.length > 1) {
    throw new PersonalContextConsentError(
      "invalid_authority",
      "Personal-context consent authority is ambiguous.",
    );
  }
  if (!rows[0]) return null;
  return authorityFromRow(rows[0], input);
}

function authorityFromRow(
  row: ConsentRow | undefined,
  input: {
    tenantId: string;
    actorBinding: CanonicalRequestActorBindingV1;
  },
) {
  const activatedAt = canonicalTimestamp(row?.activated_at);
  const consentGeneration = positiveSafeInteger(row?.consent_generation);
  if (
    !row ||
    Number(row.schema_version) !== PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION ||
    row.tenant_id !== input.tenantId ||
    row.actor_id !== input.actorBinding.canonicalActorId ||
    !consentGeneration ||
    row.contract_id !== PERSONAL_CONTEXT_CONSENT_CONTRACT_ID ||
    row.notice_contract_id !== PERSONAL_CONTEXT_NOTICE_CONTRACT_ID ||
    Number(row.notice_contract_version) !==
      PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION ||
    row.notice_sha256 !== PERSONAL_CONTEXT_NOTICE_SHA256 ||
    row.state !== "active" ||
    Number(row.lifecycle_revision) !== 1 ||
    row.activated_by_actor_id !== input.actorBinding.canonicalActorId ||
    row.revoked_by_actor_id !== null ||
    row.revoked_at !== null ||
    !activatedAt
  ) {
    throw new PersonalContextConsentError(
      "invalid_authority",
      "Personal-context consent authority is invalid.",
    );
  }
  return personalContextConsentAuthorityV1Schema.parse(
    buildPersonalContextConsentAuthorityV1({
      tenantId: input.tenantId,
      actorId: input.actorBinding.canonicalActorId,
      consentGeneration,
      activatedAt,
    }),
  );
}

async function lockConsentAuthority(
  sql: ConsentSql,
  tenantId: string,
  actorId: string,
) {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${tenantId}),
      hashtext(${`${actorId}\u001f${PERSONAL_CONTEXT_CONSENT_CONTRACT_ID}`})
    )
  `;
}

async function appendConsentEvent(input: {
  sql: ConsentSql;
  executionScope: ExecutionScope;
  authority: PersonalContextConsentAuthorityV1;
  type: (typeof PERSONAL_CONTEXT_CONSENT_EVENT_TYPES)[keyof typeof PERSONAL_CONTEXT_CONSENT_EVENT_TYPES];
  lifecycleRevision: 1 | 2;
}) {
  const eventCoordinate = [
    input.authority.tenantId,
    input.authority.actorId,
    String(input.authority.consentGeneration),
    String(input.lifecycleRevision),
  ].join("\u001f");
  await appendScopedDomainEvent({
    id: `personal-context-consent:${createHash("sha256").update(eventCoordinate).digest("hex")}`,
    streamId: `personal-context-consent:${input.authority.actorId}`,
    type: input.type,
    executionScope: input.executionScope,
    payload: {
      schemaVersion: PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION,
      contractId: PERSONAL_CONTEXT_CONSENT_CONTRACT_ID,
      actorId: input.authority.actorId,
      consentGeneration: input.authority.consentGeneration,
      lifecycleRevision: input.lifecycleRevision,
      noticeContractId: PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
      noticeContractVersion: PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION,
      noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
      authoritySha256: input.authority.authoritySha256,
    },
  }, { sql: input.sql });
}

function assertAuthorityInput(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
}) {
  const binding = input.actorBinding;
  if (
    !input.tenantId ||
    binding.version !== 1 ||
    binding.kind !== "auth_user" ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    binding.readableOwnerActorIds[0] !== binding.canonicalActorId ||
    !binding.readableOwnerActorIds.includes(binding.canonicalActorId)
  ) {
    throw new PersonalContextConsentError(
      "invalid_authority",
      "Personal-context consent authority is invalid.",
    );
  }
}

function assertMutationAuthority(input: {
  tenantId: string;
  actorBinding: CanonicalRequestActorBindingV1;
  executionScope: ExecutionScope;
}) {
  assertAuthorityInput(input);
  const scope = parsePersistedExecutionScope(input.executionScope);
  if (
    !scope ||
    scope.tenantId !== input.tenantId ||
    scope.initiatingActorId !== input.actorBinding.canonicalActorId ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== input.actorBinding.canonicalActorId ||
    scope.workspaceId !== null ||
    scope.projectId !== null ||
    scope.missionId !== null ||
    scope.delegationId !== null ||
    scope.contextGrantIds.length !== 0 ||
    scope.capabilityGrantIds.length !== 0 ||
    scope.purpose !== PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE
  ) {
    throw new PersonalContextConsentError(
      "invalid_authority",
      "Personal-context consent mutation authority is invalid.",
    );
  }
}

function positiveSafeInteger(value: unknown) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function onlyRow(rows: readonly ConsentRow[]) {
  return rows.length === 1 ? rows[0] : undefined;
}

export type PersonalContextConsentNativeAuthority = Readonly<{
  tenantId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
}>;

type NativeConsentRead = Readonly<{
  current: PersonalContextConsentNativeCurrent;
  acceptance: PersonalContextConsentNativeAcceptance | null;
}>;

function nativeConsentBinding(authority: PersonalContextConsentNativeAuthority): CanonicalRequestActorBindingV1 {
  return {
    version: 1, kind: "auth_user", authUserId: authority.ownerActorId.slice("actor:".length),
    canonicalActorId: authority.ownerActorId, legacyOwnerActorIds: [], readableOwnerActorIds: [authority.ownerActorId],
  };
}

function assertNativeConsentAuthority(authority: PersonalContextConsentNativeAuthority, purpose: string) {
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (!scope || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(authority.tenantId) ||
    !/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authority.ownerActorId) ||
    scope.tenantId !== authority.tenantId || scope.initiatingActorId !== authority.ownerActorId ||
    scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== authority.ownerActorId ||
    scope.workspaceId !== null || scope.projectId !== null || scope.missionId !== null ||
    scope.delegationId !== null || scope.contextGrantIds.length || scope.capabilityGrantIds.length ||
    scope.purpose !== purpose) {
    throw new PersonalContextConsentNativeError("personal_context_consent_authority_invalid", 403,
      "Current canonical user consent authority is required.");
  }
}

async function nativeConsentTransaction<T>(
  authority: PersonalContextConsentNativeAuthority, purpose: string, work: (sql: ConsentSql) => Promise<T>,
): Promise<T> {
  assertNativeConsentAuthority(authority, purpose);
  if (!hasDatabaseUrl()) {
    throw new PersonalContextConsentNativeError("personal_context_consent_storage_unavailable", 503,
      "Durable personal-context consent storage is unavailable.");
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(authority.tenantId, [authority.ownerActorId], () =>
    getSql().transaction(async (sql: ConsentSql) => {
      // The existing web writers and database history guards use this same
      // lock. It protects inaugural consent even when no row exists yet.
      await lockConsentAuthority(sql, authority.tenantId, authority.ownerActorId);
      return work(sql);
    }) as Promise<T>,
  );
}

function nativeConsentState(current: PersonalContextConsentNativeCurrent): PersonalContextConsentNativeState {
  return personalContextConsentNativeStateSchema.parse({
    state: current.state, consentGeneration: current.consentGeneration, lifecycleRevision: current.lifecycleRevision,
  });
}

async function nativeConsentCurrent(sql: ConsentSql, authority: PersonalContextConsentNativeAuthority) {
  const rows = await sql`SELECT * FROM omni_personal_context_consents
    WHERE tenant_id = ${authority.tenantId} AND actor_id = ${authority.ownerActorId}
    ORDER BY consent_generation DESC LIMIT 1`;
  const input = { tenantId: authority.tenantId, actorBinding: nativeConsentBinding(authority) };
  const active = await readActiveAuthority(sql, input);
  const row = rows[0];
  let state: PersonalContextConsentNativeState;
  if (!row) {
    if (active) throw new Error("Consent history is missing its active generation.");
    state = { state: "inactive", consentGeneration: 0, lifecycleRevision: 0 };
  } else {
    // Validate the complete immutable activation identity for both active and
    // revoked rows. Revocation changes only its explicit lifecycle fields.
    const activation = authorityFromRow({
      ...row, state: "active", lifecycle_revision: 1, revoked_by_actor_id: null, revoked_at: null,
    }, input);
    if (row.state === "active") {
      if (!active || active.consentGeneration !== activation.consentGeneration || Number(row.lifecycle_revision) !== 1 ||
        row.revoked_by_actor_id !== null || row.revoked_at !== null) {
        throw new Error("The latest consent generation is inconsistent with its active authority.");
      }
      state = { state: "active", consentGeneration: activation.consentGeneration, lifecycleRevision: 1 };
    } else {
      const revokedAt = canonicalTimestamp(row.revoked_at), updatedAt = canonicalTimestamp(row.updated_at);
      if (active || row.state !== "revoked" || Number(row.lifecycle_revision) !== 2 ||
        row.revoked_by_actor_id !== authority.ownerActorId || !revokedAt || revokedAt !== updatedAt ||
        revokedAt < activation.activatedAt) {
        throw new Error("The latest inactive consent generation is invalid.");
      }
      state = { state: "inactive", consentGeneration: activation.consentGeneration, lifecycleRevision: 2 };
    }
  }
  const decisionToken = personalContextConsentNativeDecisionToken({
    tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, state,
  });
  const current = personalContextConsentNativeCurrentSchema.parse({
    contract: PERSONAL_CONTEXT_CONSENT_NATIVE_READ_CONTRACT,
    tenantId: authority.tenantId, ownerActorId: authority.ownerActorId,
    ...state, notice: personalContextConsentNotice(), authority: active, decisionToken,
  });
  return { ...current, decisionToken };
}

function nativeConsentObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return nativeConsentObject(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function nativeConsentAcceptance(sql: ConsentSql, authority: PersonalContextConsentNativeAuthority, keySha256: string) {
  const acceptanceId = personalContextConsentNativeAcceptanceId(authority.tenantId, authority.ownerActorId, keySha256);
  const rows = await sql`SELECT id, tenant_id, actor_id, stream_id, type, payload FROM omni_events
    WHERE tenant_id = ${authority.tenantId} AND actor_id = ${authority.ownerActorId}
      AND id = ${acceptanceId} LIMIT 1`;
  if (!rows[0]) return null;
  const row = rows[0], payload = nativeConsentObject(row.payload);
  const stored = nativeConsentObject(payload?.nativeAcceptance);
  if (!payload || !stored || row.id !== acceptanceId || row.tenant_id !== authority.tenantId ||
    row.actor_id !== authority.ownerActorId || row.stream_id !== `personal-context-consent:${authority.ownerActorId}` ||
    row.type !== PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT || payload.schemaVersion !== 1) {
    throw new Error("Stored personal-context consent acceptance is invalid.");
  }
  // The general event sanitizer redacts Token-named properties. This opaque
  // non-secret digest alias preserves the exact accepted comparison evidence.
  const { expectedDecisionSha256, ...rest } = stored;
  const acceptance = personalContextConsentNativeAcceptanceSchema.parse({ ...rest, expectedDecisionToken: expectedDecisionSha256 });
  if (acceptance.id !== acceptanceId || acceptance.tenantId !== authority.tenantId ||
    acceptance.ownerActorId !== authority.ownerActorId || acceptance.idempotencyKeySha256 !== keySha256) {
    throw new Error("Stored personal-context consent acceptance has a different owner or request key.");
  }
  return acceptance;
}

/** Current status plus one optional immutable decision; this read grants no write authority. */
export async function readPersonalContextConsentNative(
  authority: PersonalContextConsentNativeAuthority,
  options: { acceptanceKeySha256?: string } = {},
): Promise<NativeConsentRead> {
  if (options.acceptanceKeySha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.acceptanceKeySha256)) {
    throw new PersonalContextConsentNativeError("personal_context_consent_key_digest_invalid", 400,
      "An exact consent decision key digest is required.");
  }
  return nativeConsentTransaction(authority, PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE, async (sql) => ({
    current: await nativeConsentCurrent(sql, authority),
    acceptance: options.acceptanceKeySha256 ? await nativeConsentAcceptance(sql, authority, options.acceptanceKeySha256) : null,
  }));
}

/** Native admission is atomic with both the legacy lifecycle event and its exact acceptance. */
export async function submitPersonalContextConsentNative(input: {
  authority: PersonalContextConsentNativeAuthority;
  idempotencyKey: string;
  request: PersonalContextConsentNativeRequest;
}): Promise<NativeConsentRead & { acceptance: PersonalContextConsentNativeAcceptance; newlyApplied: boolean }> {
  const { authority } = input;
  assertNativeConsentAuthority(authority, PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE);
  const intent = personalContextConsentNativeIntent({
    tenantId: authority.tenantId, ownerActorId: authority.ownerActorId,
    idempotencyKey: input.idempotencyKey, request: input.request,
  });
  return nativeConsentTransaction(authority, PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE, async (sql) => {
    const current = await nativeConsentCurrent(sql, authority);
    const prior = await nativeConsentAcceptance(sql, authority, intent.keySha256);
    if (prior) {
      if (prior.requestSha256 !== intent.requestSha256 || prior.action !== intent.request.action ||
        prior.noticeSha256 !== intent.request.noticeSha256 || prior.before.state !== intent.request.expectedState ||
        prior.before.consentGeneration !== intent.request.expectedConsentGeneration ||
        prior.before.lifecycleRevision !== intent.request.expectedLifecycleRevision ||
        !personalContextConsentNativeTokensEqual(prior.expectedDecisionToken, intent.request.expectedDecisionToken)) {
        throw new PersonalContextConsentNativeError("personal_context_consent_key_conflict", 409,
          "This key was accepted for a different consent decision.");
      }
      return { current, acceptance: prior, newlyApplied: false };
    }
    const before = nativeConsentState(current);
    if (before.state !== intent.request.expectedState || before.consentGeneration !== intent.request.expectedConsentGeneration ||
      before.lifecycleRevision !== intent.request.expectedLifecycleRevision ||
      !personalContextConsentNativeTokensEqual(current.decisionToken, intent.request.expectedDecisionToken)) {
      throw new PersonalContextConsentNativeError("personal_context_consent_state_changed", 409,
        "Consent changed after this review. Read the current notice and state before deciding again.");
    }
    const changed = intent.request.action === "activate" ? before.state === "inactive" : before.state === "active";
    const rowInput = { tenantId: authority.tenantId, actorBinding: nativeConsentBinding(authority) };
    if (changed && intent.request.action === "activate") {
      if (before.consentGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new PersonalContextConsentNativeError("personal_context_consent_generation_exhausted", 409,
          "A new consent generation cannot be created.");
      }
      const rows = await sql`INSERT INTO omni_personal_context_consents
        (tenant_id, actor_id, consent_generation, state, lifecycle_revision, activated_by_actor_id)
        VALUES (${authority.tenantId}, ${authority.ownerActorId}, ${before.consentGeneration + 1}, 'active', 1, ${authority.ownerActorId})
        RETURNING *`;
      const active = authorityFromRow(onlyRow(rows), rowInput);
      await appendConsentEvent({ sql, executionScope: authority.executionScope, authority: active,
        type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.activated, lifecycleRevision: 1 });
    } else if (changed) {
      if (!current.authority) throw new Error("Consent revocation lost its reviewed active authority.");
      const rows = await sql`UPDATE omni_personal_context_consents SET state = 'revoked', lifecycle_revision = 2,
        revoked_by_actor_id = ${authority.ownerActorId}
        WHERE tenant_id = ${authority.tenantId} AND actor_id = ${authority.ownerActorId}
          AND consent_generation = ${before.consentGeneration} AND state = 'active' AND lifecycle_revision = 1 RETURNING *`;
      if (rows.length !== 1 || rows[0].state !== "revoked" || Number(rows[0].lifecycle_revision) !== 2) {
        throw new Error("Consent revocation lost its exact generation fence.");
      }
      await appendConsentEvent({ sql, executionScope: authority.executionScope, authority: current.authority,
        type: PERSONAL_CONTEXT_CONSENT_EVENT_TYPES.revoked, lifecycleRevision: 2 });
    }
    const updated = changed ? await nativeConsentCurrent(sql, authority) : current;
    const clock = await sql`SELECT clock_timestamp() AS now`;
    const acceptedAt = canonicalTimestamp(clock[0]?.now);
    if (!acceptedAt) throw new Error("Consent acceptance clock is unavailable.");
    const acceptance = personalContextConsentNativeAcceptanceSchema.parse({
      contract: PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT, id: intent.acceptanceId,
      tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, action: intent.request.action,
      idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
      noticeSha256: intent.request.noticeSha256, expectedDecisionToken: intent.request.expectedDecisionToken,
      before, after: nativeConsentState(updated), acceptedAt, changed,
    });
    const { expectedDecisionToken, ...persistedAcceptance } = acceptance;
    await appendScopedDomainEvent({
      id: intent.acceptanceId, streamId: `personal-context-consent:${authority.ownerActorId}`,
      type: PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT, executionScope: authority.executionScope,
      payload: { schemaVersion: 1, nativeAcceptance: { ...persistedAcceptance, expectedDecisionSha256: expectedDecisionToken } },
    }, { sql });
    return { current: updated, acceptance, newlyApplied: true };
  });
}
