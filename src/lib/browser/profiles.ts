import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export const BROWSER_PROFILE_CONTRACT_VERSION = 1 as const;
export const BROWSER_TAKEOVER_CONTRACT_VERSION = 1 as const;
export const BROWSER_TAKEOVER_LEASE_MS = 10 * 60_000;
export const BROWSER_PROFILE_MAX_DOMAINS = 20;

export type BrowserProfileRecord = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  name: string;
  allowedDomains: string[];
  state: "active" | "revoked";
  lifecycleRevision: number;
  consentedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type BrowserProfileSession = Readonly<{
  id: string;
  revision: number;
  allowedDomains: string[];
}>;

export type BrowserTakeoverRecord = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  runId: string;
  executionId: string;
  profileId: string | null;
  state: "active" | "released" | "expired" | "revoked";
  actionCount: number;
  startedAt: string;
  expiresAt: string;
  lastActionAt: string | null;
  releasedAt: string | null;
}>;

export class BrowserProfileError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "invalid_contract"
      | "profile_not_found"
      | "profile_revoked"
      | "profile_ambiguous"
      | "profile_binding_changed"
      | "takeover_conflict"
      | "takeover_expired",
  ) {
    super(message);
    this.name = "BrowserProfileError";
  }
}

export function normalizeBrowserProfileDomains(values: readonly string[]) {
  if (!Array.isArray(values) || values.length < 1 || values.length > BROWSER_PROFILE_MAX_DOMAINS) {
    throw new BrowserProfileError(
      `Browser profiles require 1-${BROWSER_PROFILE_MAX_DOMAINS} allowed domains.`,
      "invalid_contract",
    );
  }
  const domains = [...new Set(values.map(normalizeBrowserProfileDomain))].sort();
  if (!domains.length || domains.length > BROWSER_PROFILE_MAX_DOMAINS) {
    throw new BrowserProfileError("Browser profile domains are invalid.", "invalid_contract");
  }
  return domains;
}

export function normalizeBrowserProfileDomain(value: string) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  let hostname = raw;
  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BrowserProfileError("Browser profile domain is invalid.", "invalid_contract");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      throw new BrowserProfileError(
        "Browser profile domains must use ordinary HTTPS origins.",
        "invalid_contract",
      );
    }
    hostname = parsed.hostname.toLowerCase();
  }
  hostname = hostname.replace(/^\*\./, "").replace(/\.$/, "");
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(hostname) ||
    hostname.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) ||
    isLocalBrowserDomain(hostname)
  ) {
    throw new BrowserProfileError("Browser profile domain is invalid.", "invalid_contract");
  }
  return hostname;
}

export function browserProfileAllowsHostname(
  allowedDomains: readonly string[],
  hostname: string,
) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) =>
    normalized === domain || normalized.endsWith(`.${domain}`)
  );
}

export function browserProfileTargetHostname(toolName: string, input: Record<string, unknown>) {
  if (toolName.trim().toLowerCase() !== "browser_navigate") return undefined;
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function listBrowserProfiles(input: {
  tenantId: string;
  ownerActorId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const rows = await getSql()`
    SELECT * FROM omni_browser_profiles
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.map(browserProfileFromRow);
}

export async function createBrowserProfile(input: {
  tenantId: string;
  ownerActorId: string;
  name: string;
  allowedDomains: string[];
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const scope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const name = requiredText(input.name, 120);
  const allowedDomains = normalizeBrowserProfileDomains(input.allowedDomains);
  const profileId = `browser_profile:${randomUUID()}`;
  const now = new Date().toISOString();
  const rows = await getSql()`
    INSERT INTO omni_browser_profiles (
      tenant_id, owner_actor_id, profile_id, name, allowed_domains, state,
      lifecycle_revision, consented_at, created_at, updated_at
    ) VALUES (
      ${tenantId}, ${ownerActorId}, ${profileId}, ${name}, ${allowedDomains},
      'active', 1, ${now}, ${now}, ${now}
    )
    RETURNING *
  `;
  const profile = browserProfileFromRow(rows[0]);
  await appendBrowserEvent(profile, scope, "browser.profile.consented", {
    profileId: profile.id,
    lifecycleRevision: profile.lifecycleRevision,
    allowedDomainSha256: profile.allowedDomains.map(sha256),
    allowedDomainCount: profile.allowedDomains.length,
  });
  return profile;
}

export async function updateBrowserProfile(input: {
  tenantId: string;
  ownerActorId: string;
  profileId: string;
  name: string;
  allowedDomains: string[];
  expectedRevision: number;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const profileId = requiredProfileId(input.profileId);
  const scope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const name = requiredText(input.name, 120);
  const allowedDomains = normalizeBrowserProfileDomains(input.allowedDomains);
  const expectedRevision = positiveInteger(input.expectedRevision);
  const rows = await getSql()`
    UPDATE omni_browser_profiles
    SET name = ${name}, allowed_domains = ${allowedDomains},
        lifecycle_revision = lifecycle_revision + 1,
        updated_at = clock_timestamp()
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND profile_id = ${profileId} AND state = 'active'
      AND lifecycle_revision = ${expectedRevision}
    RETURNING *
  `;
  if (!rows[0]) {
    throw new BrowserProfileError(
      "Browser profile changed or is no longer active.",
      "profile_binding_changed",
    );
  }
  const profile = browserProfileFromRow(rows[0]);
  await appendBrowserEvent(profile, scope, "browser.profile.scope_changed", {
    profileId: profile.id,
    lifecycleRevision: profile.lifecycleRevision,
    allowedDomainSha256: profile.allowedDomains.map(sha256),
    allowedDomainCount: profile.allowedDomains.length,
  });
  return profile;
}

export async function revokeBrowserProfile(input: {
  tenantId: string;
  ownerActorId: string;
  profileId: string;
  expectedRevision: number;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const profileId = requiredProfileId(input.profileId);
  const scope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const rows = await getSql()`
    UPDATE omni_browser_profiles
    SET state = 'revoked', lifecycle_revision = lifecycle_revision + 1,
        revoked_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND profile_id = ${profileId} AND state = 'active'
      AND lifecycle_revision = ${positiveInteger(input.expectedRevision)}
    RETURNING *
  `;
  if (!rows[0]) {
    throw new BrowserProfileError(
      "Browser profile changed or is already revoked.",
      "profile_binding_changed",
    );
  }
  const profile = browserProfileFromRow(rows[0]);
  await appendBrowserEvent(profile, scope, "browser.profile.revoked", {
    profileId: profile.id,
    lifecycleRevision: profile.lifecycleRevision,
  });
  return profile;
}

/**
 * Resolves and immutably binds a consented profile to one actor-owned run.
 * The returned metadata is ephemeral transport authority, never run memory.
 */
export async function resolveBrowserProfileSession(input: {
  tenantId: string;
  ownerActorId: string;
  executionId: string;
  targetHostname?: string;
  executionScope?: ExecutionScope;
}): Promise<BrowserProfileSession | undefined> {
  if (!hasDatabaseUrl()) return undefined;
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const executionId = requiredText(input.executionId, 320);
  const sql = getSql();
  const boundRows = await sql`
    SELECT binding.profile_id, binding.profile_revision,
           binding.allowed_domains AS bound_domains,
           profile.state, profile.lifecycle_revision,
           profile.allowed_domains
    FROM omni_browser_profile_bindings binding
    JOIN omni_browser_profiles profile
      ON profile.tenant_id = binding.tenant_id
     AND profile.owner_actor_id = binding.owner_actor_id
     AND profile.profile_id = binding.profile_id
    WHERE binding.tenant_id = ${tenantId}
      AND binding.owner_actor_id = ${ownerActorId}
      AND binding.execution_id = ${executionId}
    LIMIT 2
  `;
  if (boundRows[0]) {
    const bound = boundRows[0];
    if (String(bound.state) !== "active") {
      throw new BrowserProfileError("The bound browser profile was revoked.", "profile_revoked");
    }
    const domains = stringArray(bound.allowed_domains);
    if (
      Number(bound.profile_revision) !== Number(bound.lifecycle_revision) ||
      !stringArraysEqual(stringArray(bound.bound_domains), domains)
    ) {
      throw new BrowserProfileError(
        "The bound browser profile changed. Start a new run to use its new scope.",
        "profile_binding_changed",
      );
    }
    if (input.targetHostname && !browserProfileAllowsHostname(domains, input.targetHostname)) {
      throw new BrowserProfileError(
        "The browser destination is outside the consented profile domains.",
        "profile_binding_changed",
      );
    }
    await sql`
      UPDATE omni_browser_profiles SET last_used_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
        AND profile_id = ${String(bound.profile_id)} AND state = 'active'
    `;
    return {
      id: String(bound.profile_id),
      revision: Number(bound.lifecycle_revision),
      allowedDomains: domains,
    };
  }
  if (!input.targetHostname) return undefined;

  const profileRows = await sql`
    SELECT * FROM omni_browser_profiles
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND state = 'active'
    ORDER BY created_at ASC
    LIMIT 100
  `;
  const matching = profileRows
    .map(browserProfileFromRow)
    .filter((profile) =>
      browserProfileAllowsHostname(profile.allowedDomains, input.targetHostname || "")
    );
  if (!matching.length) return undefined;
  if (matching.length > 1) {
    throw new BrowserProfileError(
      "More than one active browser profile covers this domain. Narrow or revoke the overlapping profile.",
      "profile_ambiguous",
    );
  }
  const profile = matching[0];
  const bindingRows = await sql`
    INSERT INTO omni_browser_profile_bindings (
      tenant_id, owner_actor_id, execution_id, profile_id, profile_revision,
      allowed_domains, bound_at
    ) VALUES (
      ${tenantId}, ${ownerActorId}, ${executionId}, ${profile.id},
      ${profile.lifecycleRevision}, ${profile.allowedDomains}, clock_timestamp()
    )
    ON CONFLICT (tenant_id, owner_actor_id, execution_id) DO NOTHING
    RETURNING execution_id
  `;
  if (!bindingRows[0]) {
    return resolveBrowserProfileSession(input);
  }
  await sql`
    UPDATE omni_browser_profiles SET last_used_at = clock_timestamp()
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND profile_id = ${profile.id} AND state = 'active'
  `;
  if (input.executionScope) {
    const scope = requiredActorScope(input.executionScope, tenantId, ownerActorId);
    await appendBrowserEvent(profile, scope, "browser.profile.bound", {
      profileId: profile.id,
      lifecycleRevision: profile.lifecycleRevision,
      executionIdSha256: sha256(executionId),
      allowedDomainSha256: profile.allowedDomains.map(sha256),
    });
  }
  return {
    id: profile.id,
    revision: profile.lifecycleRevision,
    allowedDomains: profile.allowedDomains,
  };
}

export async function startBrowserTakeover(input: {
  tenantId: string;
  ownerActorId: string;
  runId: string;
  executionId: string;
  profileId?: string | null;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 500);
  const runId = requiredText(input.runId, 240);
  const executionId = requiredText(input.executionId, 240);
  const scope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BROWSER_TAKEOVER_LEASE_MS);
  const takeoverId = `browser_takeover:${randomUUID()}`;
  const sql = getSql();
  const takeover = await sql.transaction(async (tx: ReturnType<typeof getSql>) => {
    await tx`
      UPDATE omni_browser_takeovers
      SET state = 'expired', released_at = clock_timestamp()
      WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
        AND state = 'active' AND expires_at <= statement_timestamp()
    `;
    const rows = await tx`
      INSERT INTO omni_browser_takeovers (
        tenant_id, owner_actor_id, takeover_id, run_id, execution_id,
        profile_id, state, action_count, started_at, expires_at
      ) VALUES (
        ${tenantId}, ${ownerActorId}, ${takeoverId}, ${runId}, ${executionId},
        ${input.profileId || null}, 'active', 0, ${now.toISOString()},
        ${expiresAt.toISOString()}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!rows[0]) {
      throw new BrowserProfileError(
        "This run already has an active browser takeover.",
        "takeover_conflict",
      );
    }
    const record = browserTakeoverFromRow(rows[0]);
    await appendScopedDomainEvent({
      streamId: `browser-takeover:${record.id}`,
      type: "browser.takeover.started",
      executionScope: scope,
      payload: takeoverEventPayload(record),
    }, { sql: tx });
    return record;
  });
  return takeover as BrowserTakeoverRecord;
}

export async function getActiveBrowserTakeover(input: {
  tenantId: string;
  ownerActorId: string;
  runId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_browser_takeovers
    WHERE tenant_id = ${requiredText(input.tenantId, 160)}
      AND owner_actor_id = ${requiredText(input.ownerActorId, 500)}
      AND run_id = ${requiredText(input.runId, 240)}
      AND state = 'active' AND expires_at > statement_timestamp()
    ORDER BY started_at DESC
    LIMIT 2
  `;
  return rows[0] ? browserTakeoverFromRow(rows[0]) : undefined;
}

export async function recordBrowserTakeoverAction(input: {
  takeover: BrowserTakeoverRecord;
  action: string;
  target?: string;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  const action = requiredText(input.action, 80);
  const scope = requiredOwnerScope(
    input.executionScope,
    input.takeover.tenantId,
    input.takeover.ownerActorId,
  );
  const rows = await getSql()`
    UPDATE omni_browser_takeovers
    SET action_count = action_count + 1, last_action_at = clock_timestamp()
    WHERE tenant_id = ${input.takeover.tenantId}
      AND owner_actor_id = ${input.takeover.ownerActorId}
      AND takeover_id = ${input.takeover.id}
      AND state = 'active' AND expires_at > statement_timestamp()
    RETURNING *
  `;
  if (!rows[0]) {
    throw new BrowserProfileError("Browser takeover lease expired.", "takeover_expired");
  }
  const takeover = browserTakeoverFromRow(rows[0]);
  await appendScopedDomainEvent({
    streamId: `browser-takeover:${takeover.id}`,
    type: "browser.takeover.action",
    executionScope: scope,
    payload: {
      ...takeoverEventPayload(takeover),
      action,
      ...(input.target ? { targetSha256: sha256(input.target) } : {}),
    },
  });
  return takeover;
}

export async function releaseBrowserTakeover(input: {
  takeover: BrowserTakeoverRecord;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  const scope = requiredOwnerScope(
    input.executionScope,
    input.takeover.tenantId,
    input.takeover.ownerActorId,
  );
  const rows = await getSql()`
    UPDATE omni_browser_takeovers
    SET state = 'released', released_at = clock_timestamp()
    WHERE tenant_id = ${input.takeover.tenantId}
      AND owner_actor_id = ${input.takeover.ownerActorId}
      AND takeover_id = ${input.takeover.id}
      AND state = 'active' AND expires_at > statement_timestamp()
    RETURNING *
  `;
  if (!rows[0]) {
    throw new BrowserProfileError("Browser takeover lease expired.", "takeover_expired");
  }
  const takeover = browserTakeoverFromRow(rows[0]);
  await appendScopedDomainEvent({
    streamId: `browser-takeover:${takeover.id}`,
    type: "browser.takeover.released",
    executionScope: scope,
    payload: takeoverEventPayload(takeover),
  });
  return takeover;
}

function browserProfileFromRow(row: Record<string, unknown>): BrowserProfileRecord {
  return {
    id: String(row.profile_id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    name: String(row.name),
    allowedDomains: stringArray(row.allowed_domains),
    state: String(row.state) as BrowserProfileRecord["state"],
    lifecycleRevision: Number(row.lifecycle_revision),
    consentedAt: iso(row.consented_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function browserTakeoverFromRow(row: Record<string, unknown>): BrowserTakeoverRecord {
  return {
    id: String(row.takeover_id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    runId: String(row.run_id),
    executionId: String(row.execution_id),
    profileId: row.profile_id ? String(row.profile_id) : null,
    state: String(row.state) as BrowserTakeoverRecord["state"],
    actionCount: Number(row.action_count),
    startedAt: iso(row.started_at),
    expiresAt: iso(row.expires_at),
    lastActionAt: row.last_action_at ? iso(row.last_action_at) : null,
    releasedAt: row.released_at ? iso(row.released_at) : null,
  };
}

function takeoverEventPayload(takeover: BrowserTakeoverRecord) {
  return {
    schemaVersion: BROWSER_TAKEOVER_CONTRACT_VERSION,
    takeoverId: takeover.id,
    runIdSha256: sha256(takeover.runId),
    executionIdSha256: sha256(takeover.executionId),
    profileIdSha256: takeover.profileId ? sha256(takeover.profileId) : null,
    state: takeover.state,
    actionCount: takeover.actionCount,
    startedAt: takeover.startedAt,
    expiresAt: takeover.expiresAt,
    lastActionAt: takeover.lastActionAt,
    releasedAt: takeover.releasedAt,
  };
}

function appendBrowserEvent(
  profile: BrowserProfileRecord,
  executionScope: ExecutionScope,
  type: string,
  payload: Record<string, unknown>,
) {
  return appendScopedDomainEvent({
    streamId: `browser-profile:${profile.id}`,
    type,
    executionScope,
    payload: {
      schemaVersion: BROWSER_PROFILE_CONTRACT_VERSION,
      ...payload,
    },
  });
}

function requiredOwnerScope(scope: ExecutionScope, tenantId: string, actorId: string) {
  requiredActorScope(scope, tenantId, actorId);
  if (
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== actorId
  ) {
    throw new BrowserProfileError(
      "Browser profile mutation scope requires its authenticated owner.",
      "invalid_contract",
    );
  }
  return scope;
}

function requiredActorScope(scope: ExecutionScope, tenantId: string, actorId: string) {
  assertExecutionScopeTenant(scope, tenantId);
  if (scope.initiatingActorId !== actorId) {
    throw new BrowserProfileError(
      "Browser profile mutation scope does not match its owner.",
      "invalid_contract",
    );
  }
  return scope;
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new BrowserProfileError(
      "Browser profiles require the actor-scoped database ledger.",
      "database_required",
    );
  }
}

function requiredText(value: unknown, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Array.from(text).length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new BrowserProfileError("Browser profile contract contains invalid text.", "invalid_contract");
  }
  return text;
}

function requiredProfileId(value: string) {
  const id = requiredText(value, 80);
  if (!/^browser_profile:[0-9a-f-]{36}$/.test(id)) {
    throw new BrowserProfileError("Browser profile identifier is invalid.", "invalid_contract");
  }
  return id;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new BrowserProfileError("Browser profile revision is invalid.", "invalid_contract");
  }
  return number;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function iso(value: unknown) {
  return new Date(String(value)).toISOString();
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLocalBrowserDomain(hostname: string) {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    /^\d+(?:\.\d+){3}$/.test(hostname);
}
