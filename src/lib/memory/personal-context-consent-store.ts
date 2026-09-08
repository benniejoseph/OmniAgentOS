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
  type PersonalContextConsentAuthorityV1,
  type PersonalContextConsentStatusV1,
} from "@/lib/memory/personal-context-consent";
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
