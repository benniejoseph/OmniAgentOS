import { Buffer } from "node:buffer";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export const DATABASE_MEMORY_ACCESS_SCOPE_VERSION = 1 as const;
export const MAX_DATABASE_MEMORY_ACCESS_GRANT_IDS = 256;
export const MAX_DATABASE_MEMORY_ACCESS_SCOPE_BYTES = 262_144;

const DATABASE_MEMORY_ACCESS_SCOPE_KEYS = [
  "version",
  "tenantId",
  "initiatingActorId",
  "executingPrincipalType",
  "executingPrincipalId",
  "workspaceId",
  "projectId",
  "missionId",
  "contextGrantIds",
  "capabilityGrantIds",
  "purposeId",
  "purpose",
] as const;

const DATABASE_MEMORY_ACCESS_SCOPE_KEY_SET = new Set<string>(
  DATABASE_MEMORY_ACCESS_SCOPE_KEYS,
);
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;

export type DatabaseMemoryAccessPrincipalType = "user" | "agent" | "system";

export type DatabaseMemoryAccessScope = Readonly<{
  version: typeof DATABASE_MEMORY_ACCESS_SCOPE_VERSION;
  tenantId: string;
  initiatingActorId: string;
  executingPrincipalType: DatabaseMemoryAccessPrincipalType;
  executingPrincipalId: string;
  workspaceId: string | null;
  projectId: string | null;
  missionId: string | null;
  contextGrantIds: readonly string[];
  capabilityGrantIds: readonly string[];
  purposeId: string;
  purpose: string | null;
}>;

export type DatabaseMemoryAccessPurpose = Readonly<{
  purposeId: string;
  auditPurpose: string | null;
}>;

type TransactionScopedSql = {
  (
    strings: TemplateStringsArray,
    ...parameters: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  readonly transactionScoped: boolean;
};

export class DatabaseMemoryAccessScopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseMemoryAccessScopeError";
  }
}

/**
 * Parses the exact v44 database envelope. This is structural validation only:
 * it does not prove membership, consent, grant ownership, or purpose authority.
 */
export function parseDatabaseMemoryAccessScope(
  value: unknown,
): DatabaseMemoryAccessScope {
  if (!isPlainRecord(value) || !hasExactScopeKeys(value)) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope must use the exact version-1 shape.",
    );
  }

  const version = value.version;
  const executingPrincipalType = value.executingPrincipalType;
  if (version !== DATABASE_MEMORY_ACCESS_SCOPE_VERSION) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope version is invalid.",
    );
  }
  if (!isMemoryAccessPrincipalType(executingPrincipalType)) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access principal type is invalid.",
    );
  }

  const tenantId = contractId(value.tenantId, "tenantId");
  const initiatingActorId = contractId(
    value.initiatingActorId,
    "initiatingActorId",
  );
  const executingPrincipalId = contractId(
    value.executingPrincipalId,
    "executingPrincipalId",
  );
  if (
    executingPrincipalType === "user" &&
    executingPrincipalId !== initiatingActorId
  ) {
    throw new DatabaseMemoryAccessScopeError(
      "A user memory principal must equal the initiating actor.",
    );
  }

  const scope = Object.freeze({
    version: DATABASE_MEMORY_ACCESS_SCOPE_VERSION,
    tenantId,
    initiatingActorId,
    executingPrincipalType,
    executingPrincipalId,
    workspaceId: optionalContractId(value.workspaceId, "workspaceId"),
    projectId: optionalContractId(value.projectId, "projectId"),
    missionId: optionalContractId(value.missionId, "missionId"),
    contextGrantIds: canonicalGrantIds(
      value.contextGrantIds,
      "contextGrantIds",
    ),
    capabilityGrantIds: canonicalGrantIds(
      value.capabilityGrantIds,
      "capabilityGrantIds",
    ),
    purposeId: contractId(value.purposeId, "purposeId"),
    purpose: auditPurpose(value.purpose),
  }) satisfies DatabaseMemoryAccessScope;

  if (
    Buffer.byteLength(serializeParsedDatabaseMemoryAccessScope(scope), "utf8") >
    MAX_DATABASE_MEMORY_ACCESS_SCOPE_BYTES
  ) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope exceeds the encoded byte limit.",
    );
  }
  return scope;
}

export function serializeDatabaseMemoryAccessScope(value: unknown): string {
  return serializeParsedDatabaseMemoryAccessScope(
    parseDatabaseMemoryAccessScope(value),
  );
}

/**
 * Copies attribution from an execution scope without treating it as proof of
 * access. The caller must supply the canonical purpose ID independently; the
 * free-form ExecutionScope purpose is deliberately not read or inferred.
 */
export function databaseMemoryAccessScopeFromExecutionScope(
  executionScope: ExecutionScope,
  purpose: DatabaseMemoryAccessPurpose,
): DatabaseMemoryAccessScope {
  if (executionScope.version !== DATABASE_MEMORY_ACCESS_SCOPE_VERSION) {
    throw new DatabaseMemoryAccessScopeError(
      "Execution scope cannot be adapted to the memory access contract.",
    );
  }
  return parseDatabaseMemoryAccessScope({
    version: DATABASE_MEMORY_ACCESS_SCOPE_VERSION,
    tenantId: executionScope.tenantId,
    initiatingActorId: executionScope.initiatingActorId,
    executingPrincipalType: executionScope.executingPrincipalType,
    executingPrincipalId: executionScope.executingPrincipalId,
    workspaceId: executionScope.workspaceId,
    projectId: executionScope.projectId,
    missionId: executionScope.missionId,
    contextGrantIds: sortedGrantIds(
      executionScope.contextGrantIds,
      "contextGrantIds",
    ),
    capabilityGrantIds: sortedGrantIds(
      executionScope.capabilityGrantIds,
      "capabilityGrantIds",
    ),
    purposeId: purpose.purposeId,
    purpose: purpose.auditPurpose,
  });
}

/**
 * Writes one already-authorized scope to an existing database transaction.
 *
 * This function is deliberately unusable by serving roles until the atomic
 * actor-aware cutover grants the v44 functions. It never opens a connection or
 * transaction, never accepts maintenance scope, and rejects nested/replacement
 * scopes. Callers must make it the first awaited action in their transaction.
 */
export async function setTransactionLocalDatabaseMemoryAccessScope(
  transaction: TransactionScopedSql,
  value: unknown,
): Promise<DatabaseMemoryAccessScope> {
  if (!transaction.transactionScoped) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope requires an existing transaction callback.",
    );
  }

  const scope = parseDatabaseMemoryAccessScope(value);
  const serialized = serializeParsedDatabaseMemoryAccessScope(scope);
  const preflightRows = await transaction`
    SELECT CASE
      WHEN public.omni_memory_access_scope_v1_is_valid(
        ${serialized}::JSONB
      )
        AND NULLIF(current_setting('omni.tenant_id', TRUE), '')
          = ${scope.tenantId}
        AND current_setting('omni.system_scope', TRUE) = 'false'
        AND NULLIF(
          current_setting('omni.memory_access_scope_v1', TRUE),
          ''
        ) IS NULL
      THEN set_config(
        'omni.memory_access_scope_v1',
        ${serialized},
        TRUE
      )
      ELSE NULL
    END AS applied_scope
  `;
  if (preflightRows[0]?.applied_scope !== serialized) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope preflight was not authorized.",
    );
  }

  const postflightRows = await transaction`
    SELECT public.omni_current_memory_access_scope_v1()
      AS memory_access_scope
  `;
  try {
    const observed = parseDatabaseMemoryAccessScope(
      parseDatabaseJsonValue(postflightRows[0]?.memory_access_scope),
    );
    if (serializeParsedDatabaseMemoryAccessScope(observed) !== serialized) {
      throw new DatabaseMemoryAccessScopeError(
        "Database memory access scope postflight did not match.",
      );
    }
  } catch (error) {
    await transaction`
      SELECT set_config('omni.memory_access_scope_v1', '', TRUE)
    `;
    if (error instanceof DatabaseMemoryAccessScopeError) {
      throw error;
    }
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope postflight was invalid.",
      { cause: error },
    );
  }

  return scope;
}

function serializeParsedDatabaseMemoryAccessScope(
  scope: DatabaseMemoryAccessScope,
): string {
  return JSON.stringify(scope);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactScopeKeys(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === DATABASE_MEMORY_ACCESS_SCOPE_KEYS.length &&
    keys.every(
      (key) => {
        if (
          typeof key !== "string" ||
          !DATABASE_MEMORY_ACCESS_SCOPE_KEY_SET.has(key)
        ) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(
          descriptor && descriptor.enumerable && "value" in descriptor,
        );
      },
    );
}

function contractId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value !== value.trim() ||
    !CONTRACT_ID_PATTERN.test(value)
  ) {
    throw new DatabaseMemoryAccessScopeError(
      `Database memory access scope ${field} is not a canonical ID.`,
    );
  }
  return value;
}

function optionalContractId(value: unknown, field: string): string | null {
  return value === null ? null : contractId(value, field);
}

function canonicalGrantIds(value: unknown, field: string): readonly string[] {
  const ids = jsonArrayEntries(value, field).map((entry) =>
    contractId(entry, field)
  );
  for (let index = 1; index < ids.length; index += 1) {
    if (compareContractIds(ids[index - 1], ids[index]) >= 0) {
      throw new DatabaseMemoryAccessScopeError(
        `Database memory access scope ${field} must be C-sorted and unique.`,
      );
    }
  }
  return Object.freeze(ids);
}

function sortedGrantIds(value: unknown, field: string): readonly string[] {
  const ids = jsonArrayEntries(value, field).map((entry) =>
    contractId(entry, field)
  );
  if (new Set(ids).size !== ids.length) {
    throw new DatabaseMemoryAccessScopeError(
      `Database memory access scope ${field} must be unique.`,
    );
  }
  return Object.freeze([...ids].sort(compareContractIds));
}

function jsonArrayEntries(value: unknown, field: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_DATABASE_MEMORY_ACCESS_GRANT_IDS
  ) {
    throw new DatabaseMemoryAccessScopeError(
      `Database memory access scope ${field} is invalid.`,
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  ) {
    throw new DatabaseMemoryAccessScopeError(
      `Database memory access scope ${field} is not a plain JSON array.`,
    );
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new DatabaseMemoryAccessScopeError(
        `Database memory access scope ${field} is not a dense JSON array.`,
      );
    }
    return descriptor.value;
  });
}

function compareContractIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function auditPurpose(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    unicodeCodePointLength(value) < 1 ||
    unicodeCodePointLength(value) > 500 ||
    !isPostgresText(value)
  ) {
    throw new DatabaseMemoryAccessScopeError(
      "Database memory access scope purpose is invalid.",
    );
  }
  return value;
}

function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

function isPostgresText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isMemoryAccessPrincipalType(
  value: unknown,
): value is DatabaseMemoryAccessPrincipalType {
  return value === "user" || value === "agent" || value === "system";
}

function parseDatabaseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
