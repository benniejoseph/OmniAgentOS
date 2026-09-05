import {
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import {
  parseDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import {
  CANONICAL_REQUEST_ACTOR_BINDING_VERSION,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";

export const MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION = 1 as const;

export const MEMORY_AUTHORITY_UNAVAILABLE_CODES = Object.freeze([
  "canonical_scope_actor",
  "canonical_actor",
  "tenant_membership",
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
] as const);

export type MemoryAuthorityUnavailable =
  (typeof MEMORY_AUTHORITY_UNAVAILABLE_CODES)[number];

export type MemoryAuthorityResolutionCanaryResultV1 = Readonly<{
  schemaVersion: typeof MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION;
  decision: "deny";
  reason: "activation_held";
  unavailableAuthorities: readonly MemoryAuthorityUnavailable[];
}>;

export type MemoryAuthorityDenialCanaryInput = Readonly<{
  accessScope: unknown;
  actorBinding: CanonicalRequestActorBindingV1;
}>;

export type MemoryAuthorityDenialCanaryErrorCode =
  | "invalid_input"
  | "postgres_required"
  | "database_scope_invariant"
  | "authority_read_failed";

const ERROR_MESSAGES = Object.freeze({
  invalid_input: "Memory authority canary input is invalid.",
  postgres_required: "Memory authority canary requires PostgreSQL.",
  database_scope_invariant:
    "Memory authority canary database scope was rejected.",
  authority_read_failed: "Memory authority canary read failed.",
} satisfies Record<MemoryAuthorityDenialCanaryErrorCode, string>);

export class MemoryAuthorityDenialCanaryError extends Error {
  readonly code: MemoryAuthorityDenialCanaryErrorCode;

  constructor(code: MemoryAuthorityDenialCanaryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MemoryAuthorityDenialCanaryError";
    this.code = code;
  }
}

type CanarySql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

type ObservedConsentCoordinates = Readonly<{
  consentGeneration: number;
  membershipEpoch: number;
  noticeReceiptId: string;
}>;

type ObservedNoticeContractCoordinates = Readonly<{
  noticeContractId: string;
  noticeContractVersion: number;
}>;

const INPUT_KEYS = ["accessScope", "actorBinding"] as const;
const ACTOR_BINDING_KEYS = [
  "version",
  "kind",
  "authUserId",
  "canonicalActorId",
  "legacyOwnerActorIds",
  "readableOwnerActorIds",
] as const;
const CANONICAL_AUTH_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_CLASSES = new Set([
  "read",
  "retrieve",
  "write",
  "correct",
  "forget",
  "formation",
  "maintenance",
  "export",
]);

class DatabaseScopeInvariantError extends Error {}

/**
 * Observes the dormant memory-authority shadows without authorizing access.
 *
 * The returned contract has no allow variant. This function owns and closes
 * the transaction that holds its row locks, never installs a memory access
 * scope, and is not suitable as an authorization predicate.
 */
export async function inspectMemoryAuthorityDenialCanary(
  input: MemoryAuthorityDenialCanaryInput,
): Promise<MemoryAuthorityResolutionCanaryResultV1> {
  let scope: DatabaseMemoryAccessScope;
  let actorBinding: CanonicalRequestActorBindingV1;
  try {
    if (!isExactPlainDataRecord(input, INPUT_KEYS)) {
      throw new Error("invalid input shape");
    }
    actorBinding = parseCanonicalActorBinding(input.actorBinding);
    scope = parseDatabaseMemoryAccessScope(input.accessScope);
    if (!bindingContainsActor(actorBinding, scope.initiatingActorId)) {
      throw new Error("actor binding mismatch");
    }
  } catch {
    throw new MemoryAuthorityDenialCanaryError("invalid_input");
  }

  if (!hasDatabaseUrl()) {
    throw new MemoryAuthorityDenialCanaryError("postgres_required");
  }

  try {
    return await runWithDatabaseTenantScope(scope.tenantId, async () => {
      const transactionResult = await getSql().transaction(
        async (sql: CanarySql) =>
          inspectInOwnedTransaction(sql, scope, actorBinding),
      );
      return transactionResult as MemoryAuthorityResolutionCanaryResultV1;
    });
  } catch (error) {
    if (error instanceof DatabaseScopeInvariantError) {
      throw new MemoryAuthorityDenialCanaryError(
        "database_scope_invariant",
      );
    }
    if (error instanceof MemoryAuthorityDenialCanaryError) {
      throw error;
    }
    throw new MemoryAuthorityDenialCanaryError("authority_read_failed");
  }
}

async function inspectInOwnedTransaction(
  sql: CanarySql,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
): Promise<MemoryAuthorityResolutionCanaryResultV1> {
  await assertTransactionScope(sql, scope.tenantId);

  const unavailable = new Set<MemoryAuthorityUnavailable>();
  if (scope.initiatingActorId !== actorBinding.canonicalActorId) {
    unavailable.add("canonical_scope_actor");
  }
  // The held grant and policy ledgers are not yet consumed by this canary.
  // Keep those inputs unavailable until their exact target and request
  // bindings are observed under the same transaction locks.
  unavailable.add("executing_principal_authority");
  unavailable.add("context_grant_authority");
  unavailable.add("capability_grant_authority");
  unavailable.add("operation_policy_authority");

  const authUserRows = await sql`
    SELECT id, actor_id, status
    FROM public.omni_auth_users
    WHERE id = ${actorBinding.authUserId}
      AND actor_id = ${actorBinding.canonicalActorId}
    ORDER BY id ASC
    LIMIT 2
    FOR SHARE
  `;
  const authUserAvailable = isActiveAuthUser(
    onlyRow(authUserRows),
    actorBinding,
  );
  if (!authUserAvailable) {
    unavailable.add("canonical_actor");
    unavailable.add("executing_principal_authority");
    return deniedResult(unavailable);
  }

  const membershipRows = await sql`
    SELECT id, tenant_id, user_id, status
    FROM public.omni_auth_memberships
    WHERE tenant_id = ${scope.tenantId}
      AND user_id = ${actorBinding.authUserId}
    ORDER BY id ASC
    LIMIT 2
    FOR SHARE
  `;
  const membershipAvailable = isActiveMembership(
    onlyRow(membershipRows),
    scope,
    actorBinding,
  );
  if (!membershipAvailable) {
    unavailable.add("tenant_membership");
    unavailable.add("executing_principal_authority");
    return deniedResult(unavailable);
  }

  if (
    await hasActiveExecutingPrincipalAuthority(
      sql,
      scope,
      actorBinding,
    )
  ) {
    unavailable.delete("executing_principal_authority");
  }

  const epochRows = await sql`
    SELECT
      schema_version,
      tenant_id,
      subject_actor_id,
      membership_epoch,
      state,
      lifecycle_revision
    FROM public.omni_tenant_actor_membership_epochs
    WHERE tenant_id = ${scope.tenantId}
      AND subject_actor_id = ${actorBinding.canonicalActorId}
      AND state <> 'revoked'
    ORDER BY membership_epoch DESC
    LIMIT 2
    FOR SHARE
  `;
  const membershipEpoch = activeMembershipEpoch(
    onlyRow(epochRows),
    scope,
    actorBinding,
  );
  if (membershipEpoch === undefined) {
    unavailable.add("membership_epoch");
    return deniedResult(unavailable);
  }

  const purposeRows = await sql`
    SELECT purpose_id, contract_version, operation_class
    FROM public.omni_memory_purpose_catalog
    WHERE purpose_id = ${scope.purposeId}
    ORDER BY purpose_id ASC, contract_version ASC
    LIMIT 2
    FOR SHARE
  `;
  const purposeAvailable = isPurposeContract(
    onlyRow(purposeRows),
    scope.purposeId,
  );
  if (!purposeAvailable) {
    unavailable.add("purpose_contract");
    return deniedResult(unavailable);
  }

  if (isRequestBoundDataRight(scope.purposeId)) {
    unavailable.add("request_bound_data_right_authority");
    return deniedResult(unavailable);
  } else {
    await inspectStandingAuthorities(
      sql,
      scope,
      actorBinding,
      membershipEpoch,
      unavailable,
    );
  }

  return deniedResult(unavailable);
}

async function hasActiveExecutingPrincipalAuthority(
  sql: CanarySql,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
): Promise<boolean> {
  if (scope.executingPrincipalType === "user") {
    return (
      scope.initiatingActorId === actorBinding.canonicalActorId &&
      scope.executingPrincipalId === actorBinding.canonicalActorId
    );
  }

  const principalRows = await sql`
    SELECT
      schema_version,
      tenant_id,
      principal_kind,
      principal_id,
      principal_generation,
      controller_actor_id,
      state,
      lifecycle_revision
    FROM public.omni_tenant_execution_principals
    WHERE tenant_id = ${scope.tenantId}
      AND principal_kind = ${scope.executingPrincipalType}
      AND principal_id = ${scope.executingPrincipalId}
      AND state <> 'revoked'
    ORDER BY principal_generation DESC
    LIMIT 2
    FOR SHARE
  `;
  const row = onlyRow(principalRows);
  return Boolean(
    row &&
      numericValue(row.schema_version) === 1 &&
      row.tenant_id === scope.tenantId &&
      row.principal_kind === scope.executingPrincipalType &&
      row.principal_id === scope.executingPrincipalId &&
      positiveSafeInteger(row.principal_generation) !== undefined &&
      row.controller_actor_id === actorBinding.canonicalActorId &&
      row.state === "active" &&
      numericValue(row.lifecycle_revision) === 1,
  );
}

async function inspectStandingAuthorities(
  sql: CanarySql,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
  membershipEpoch: number | undefined,
  unavailable: Set<MemoryAuthorityUnavailable>,
): Promise<void> {
  const entitlementRows = await sql`
    SELECT
      schema_version,
      tenant_id,
      purpose_id,
      entitlement_generation,
      state,
      lifecycle_revision
    FROM public.omni_tenant_memory_purpose_entitlements
    WHERE tenant_id = ${scope.tenantId}
      AND purpose_id = ${scope.purposeId}
      AND state <> 'revoked'
    ORDER BY entitlement_generation DESC
    LIMIT 2
    FOR SHARE
  `;
  if (!isActiveEntitlement(onlyRow(entitlementRows), scope)) {
    unavailable.add("tenant_entitlement");
    return;
  }

  const consentRows = await sql`
    SELECT
      schema_version,
      tenant_id,
      subject_actor_id,
      purpose_id,
      consent_generation,
      membership_epoch,
      notice_receipt_id,
      state,
      lifecycle_revision,
      granted_by_actor_id,
      granted_at
    FROM public.omni_tenant_actor_memory_purpose_consents
    WHERE tenant_id = ${scope.tenantId}
      AND subject_actor_id = ${actorBinding.canonicalActorId}
      AND purpose_id = ${scope.purposeId}
      AND state <> 'revoked'
    ORDER BY consent_generation DESC
    LIMIT 2
    FOR SHARE
  `;
  const consentCoordinates = grantedConsentCoordinates(
    onlyRow(consentRows),
    scope,
    actorBinding,
    membershipEpoch,
  );
  if (!consentCoordinates) {
    unavailable.add("standing_consent");
    unavailable.add("informed_notice_evidence");
    return;
  }

  const receiptRows = await sql`
    SELECT
      schema_version,
      tenant_id,
      subject_actor_id,
      purpose_id,
      consent_generation,
      membership_epoch,
      notice_receipt_id,
      notice_contract_id,
      notice_contract_version,
      presented_at,
      acknowledged_by_actor_id,
      acknowledged_at
    FROM public.omni_tenant_actor_memory_notice_receipts
    WHERE tenant_id = ${scope.tenantId}
      AND subject_actor_id = ${actorBinding.canonicalActorId}
      AND purpose_id = ${scope.purposeId}
      AND consent_generation = ${consentCoordinates.consentGeneration}
      AND membership_epoch = ${consentCoordinates.membershipEpoch}
      AND notice_receipt_id = ${consentCoordinates.noticeReceiptId}
    ORDER BY
      tenant_id ASC,
      subject_actor_id ASC,
      purpose_id ASC,
      consent_generation ASC,
      membership_epoch ASC,
      notice_receipt_id ASC
    LIMIT 2
    FOR SHARE
  `;
  const noticeContractCoordinates = acknowledgedNoticeCoordinates(
    onlyRow(receiptRows),
    scope,
    actorBinding,
    consentCoordinates,
  );
  if (!noticeContractCoordinates) {
    unavailable.add("informed_notice_evidence");
    return;
  }

  const noticeContractRows = await sql`
    SELECT
      schema_version,
      purpose_id,
      notice_contract_id,
      notice_contract_version,
      notice_sha256
    FROM public.omni_memory_informed_notice_contracts
    WHERE purpose_id = ${scope.purposeId}
      AND notice_contract_id = ${noticeContractCoordinates.noticeContractId}
      AND notice_contract_version = ${noticeContractCoordinates.noticeContractVersion}
    ORDER BY
      purpose_id ASC,
      notice_contract_id ASC,
      notice_contract_version ASC
    LIMIT 2
    FOR SHARE
  `;
  if (
    !isNoticeContract(
      onlyRow(noticeContractRows),
      scope,
      noticeContractCoordinates,
    )
  ) {
    unavailable.add("informed_notice_evidence");
  }
}

async function assertTransactionScope(
  sql: CanarySql,
  tenantId: string,
): Promise<void> {
  if (!sql.transactionScoped) throw new DatabaseScopeInvariantError();
  const rows = await sql`
    SELECT
      NULLIF(current_setting('omni.tenant_id', TRUE), '') AS tenant_id,
      current_setting('omni.system_scope', TRUE) AS system_scope,
      NULLIF(
        current_setting('omni.memory_access_scope_v1', TRUE),
        ''
      ) AS memory_access_scope
  `;
  const row = onlyRow(rows);
  if (
    !row ||
    row.tenant_id !== tenantId ||
    row.system_scope !== "false" ||
    (row.memory_access_scope !== null &&
      row.memory_access_scope !== undefined)
  ) {
    throw new DatabaseScopeInvariantError();
  }
}

function isActiveAuthUser(
  row: SqlRow | undefined,
  actorBinding: CanonicalRequestActorBindingV1,
): boolean {
  return Boolean(
    row &&
      row.id === actorBinding.authUserId &&
      row.actor_id === actorBinding.canonicalActorId &&
      row.status === "active",
  );
}

function isActiveMembership(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
): boolean {
  return Boolean(
    row &&
      isContractId(row.id) &&
      row.tenant_id === scope.tenantId &&
      row.user_id === actorBinding.authUserId &&
      row.status === "active",
  );
}

function activeMembershipEpoch(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
): number | undefined {
  const epoch = positiveSafeInteger(row?.membership_epoch);
  if (
    !row ||
    numericValue(row.schema_version) !== 1 ||
    row.tenant_id !== scope.tenantId ||
    row.subject_actor_id !== actorBinding.canonicalActorId ||
    epoch === undefined ||
    row.state !== "active" ||
    numericValue(row.lifecycle_revision) !== 1
  ) {
    return undefined;
  }
  return epoch;
}

function isPurposeContract(
  row: SqlRow | undefined,
  purposeId: string,
): boolean {
  const contractVersion = positiveSafeInteger(row?.contract_version);
  const operationClass = row?.operation_class;
  return Boolean(
    row &&
      row.purpose_id === purposeId &&
      contractVersion !== undefined &&
      contractVersion <= 32_767 &&
      typeof operationClass === "string" &&
      OPERATION_CLASSES.has(operationClass) &&
      purposeId === `memory.${operationClass}.v${contractVersion}`,
  );
}

function isActiveEntitlement(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
): boolean {
  return Boolean(
    row &&
      numericValue(row.schema_version) === 1 &&
      row.tenant_id === scope.tenantId &&
      row.purpose_id === scope.purposeId &&
      positiveSafeInteger(row.entitlement_generation) !== undefined &&
      row.state === "active" &&
      numericValue(row.lifecycle_revision) === 1,
  );
}

function grantedConsentCoordinates(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
  activeEpoch: number | undefined,
): ObservedConsentCoordinates | undefined {
  const consentGeneration = positiveSafeInteger(row?.consent_generation);
  const membershipEpoch = positiveSafeInteger(row?.membership_epoch);
  if (
    !row ||
    numericValue(row.schema_version) !== 2 ||
    row.tenant_id !== scope.tenantId ||
    row.subject_actor_id !== actorBinding.canonicalActorId ||
    row.purpose_id !== scope.purposeId ||
    consentGeneration === undefined ||
    membershipEpoch === undefined ||
    activeEpoch === undefined ||
    membershipEpoch !== activeEpoch ||
    !isContractId(row.notice_receipt_id) ||
    row.state !== "granted" ||
    numericValue(row.lifecycle_revision) !== 1 ||
    row.granted_by_actor_id !== actorBinding.canonicalActorId ||
    timestampMilliseconds(row.granted_at) === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    consentGeneration,
    membershipEpoch,
    noticeReceiptId: row.notice_receipt_id,
  });
}

function acknowledgedNoticeCoordinates(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
  actorBinding: CanonicalRequestActorBindingV1,
  consent: ObservedConsentCoordinates,
): ObservedNoticeContractCoordinates | undefined {
  const consentGeneration = positiveSafeInteger(row?.consent_generation);
  const membershipEpoch = positiveSafeInteger(row?.membership_epoch);
  const noticeContractVersion = positiveSafeInteger(
    row?.notice_contract_version,
  );
  const presentedAt = timestampMilliseconds(row?.presented_at);
  const acknowledgedAt = timestampMilliseconds(row?.acknowledged_at);
  if (
    !row ||
    numericValue(row.schema_version) !== 1 ||
    row.tenant_id !== scope.tenantId ||
    row.subject_actor_id !== actorBinding.canonicalActorId ||
    row.purpose_id !== scope.purposeId ||
    consentGeneration !== consent.consentGeneration ||
    membershipEpoch !== consent.membershipEpoch ||
    row.notice_receipt_id !== consent.noticeReceiptId ||
    !isContractId(row.notice_contract_id) ||
    noticeContractVersion === undefined ||
    noticeContractVersion > 32_767 ||
    row.acknowledged_by_actor_id !== actorBinding.canonicalActorId ||
    presentedAt === undefined ||
    acknowledgedAt === undefined ||
    presentedAt > acknowledgedAt
  ) {
    return undefined;
  }
  return Object.freeze({
    noticeContractId: row.notice_contract_id,
    noticeContractVersion,
  });
}

function isNoticeContract(
  row: SqlRow | undefined,
  scope: DatabaseMemoryAccessScope,
  coordinates: ObservedNoticeContractCoordinates,
): boolean {
  return Boolean(
    row &&
      numericValue(row.schema_version) === 1 &&
      row.purpose_id === scope.purposeId &&
      row.notice_contract_id === coordinates.noticeContractId &&
      positiveSafeInteger(row.notice_contract_version) ===
        coordinates.noticeContractVersion &&
      typeof row.notice_sha256 === "string" &&
      LOWERCASE_SHA256_PATTERN.test(row.notice_sha256),
  );
}

function deniedResult(
  unavailable: ReadonlySet<MemoryAuthorityUnavailable>,
): MemoryAuthorityResolutionCanaryResultV1 {
  const unavailableAuthorities = Object.freeze(
    MEMORY_AUTHORITY_UNAVAILABLE_CODES.filter((code) => unavailable.has(code)),
  );
  return Object.freeze({
    schemaVersion: MEMORY_AUTHORITY_RESOLUTION_CANARY_SCHEMA_VERSION,
    decision: "deny" as const,
    reason: "activation_held" as const,
    unavailableAuthorities,
  });
}

function parseCanonicalActorBinding(
  value: unknown,
): CanonicalRequestActorBindingV1 {
  if (
    !isExactPlainDataRecord(value, ACTOR_BINDING_KEYS) ||
    !Object.isFrozen(value) ||
    value.version !== CANONICAL_REQUEST_ACTOR_BINDING_VERSION ||
    value.kind !== "auth_user" ||
    typeof value.authUserId !== "string" ||
    !CANONICAL_AUTH_USER_ID_PATTERN.test(value.authUserId) ||
    value.canonicalActorId !== `actor:${value.authUserId}` ||
    !isExactFrozenStringArray(value.legacyOwnerActorIds, 1) ||
    !isExactFrozenStringArray(value.readableOwnerActorIds, 2)
  ) {
    throw new Error("invalid actor binding");
  }

  const legacyActorId = value.legacyOwnerActorIds[0];
  if (
    !legacyActorId ||
    legacyActorId !== legacyActorId.trim() ||
    Array.from(legacyActorId).length > 320 ||
    legacyActorId === value.canonicalActorId ||
    value.readableOwnerActorIds[0] !== value.canonicalActorId ||
    value.readableOwnerActorIds[1] !== legacyActorId
  ) {
    throw new Error("invalid actor binding");
  }
  return value as CanonicalRequestActorBindingV1;
}

function bindingContainsActor(
  binding: CanonicalRequestActorBindingV1,
  actorId: string,
): boolean {
  return binding.readableOwnerActorIds.includes(actorId);
}

function isExactPlainDataRecord<const TKeys extends readonly string[]>(
  value: unknown,
  expectedKeys: TKeys,
): value is Record<TKeys[number], unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const expected = new Set<string>(expectedKeys);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => {
      if (typeof key !== "string" || !expected.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor && descriptor.enumerable && "value" in descriptor,
      );
    })
  );
}

function isExactFrozenStringArray(
  value: unknown,
  expectedLength: number,
): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.isFrozen(value) ||
    value.length !== expectedLength
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedLength + 1 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function isRequestBoundDataRight(purposeId: string): boolean {
  return (
    purposeId.startsWith("memory.export.v") ||
    purposeId.startsWith("memory.forget.v")
  );
}

function isContractId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    value === value.trim() &&
    CONTRACT_ID_PATTERN.test(value)
  );
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = numericValue(value);
  return parsed !== undefined && parsed >= 1 ? parsed : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof value !== "string" || value !== value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function onlyRow(rows: SqlRow[]): SqlRow | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}
