import { createHash, randomBytes, randomUUID } from "node:crypto";
import { privateAccountPolicyForIdentity } from "@/lib/auth/private-account-policy";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import { enterDatabaseSecurityContext, requirePermission } from "@/lib/security/context";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext, SecurityRole } from "@/lib/security/types";
import { LISTEN_PROCESSING_TERMS, ListenError } from "./listen-contracts";

export const listenDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type ListenAuthority = { context: SecurityContext; grantId: string; origin: string };

export async function requireListenDatabase() {
  if (!hasDatabaseUrl()) throw new ListenError(503, "listen_storage_unavailable", "Conversation storage is temporarily unavailable.");
  await ensureDatabaseSchema();
}

export async function updateListenGrant(context: SecurityContext, request: Request,
  input: { action: "issue" | "revoke"; timeZone: string }) {
  if (context.source !== "mobile" || context.native?.platform !== "android" || !context.auth) {
    throw new ListenError(403, "listen_phone_required", "Open Listen on your Android phone to enable background processing.");
  }
  await requireListenDatabase();
  const native = context.native, auth = context.auth;
  const origin = new URL(request.url).origin;
  if (!origin.startsWith("https://") && process.env.NODE_ENV === "production") {
    throw new ListenError(503, "listen_secure_service_required", "A secure command service is required.");
  }
  const id = `listen-grant:${randomUUID()}`;
  const scope = executionScopeFromSecurityContext(context, { purpose: `listen.grant.${input.action}`, correlationId: id });
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    await sql`UPDATE omni_listen_grants SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE tenant_id = ${context.tenantId} AND actor_id = ${context.actorId}
        AND device_id = ${native.deviceId} AND api_origin = ${origin} AND revoked_at IS NULL`;
    if (input.action === "issue") {
      await sql`INSERT INTO omni_listen_grants (id, tenant_id, actor_id, user_id, mobile_session_id, device_id,
        actor_role, api_origin, token_sha256, expires_at, time_zone, processing_terms)
        VALUES (${id}, ${context.tenantId}, ${context.actorId}, ${auth.userId}, ${auth.sessionId}, ${native.deviceId},
          ${context.role}, ${origin}, ${listenDigest(token)}, ${expiresAt}, ${input.timeZone}, ${LISTEN_PROCESSING_TERMS})`;
    }
    await appendScopedDomainEvent({ streamId: `listen-device:${listenDigest(native.deviceId)}`, type: `listen.grant.${input.action === "issue" ? "issued" : "revoked"}`,
      executionScope: scope, payload: { schemaVersion: 1, grantId: input.action === "issue" ? id : null,
        processingTerms: LISTEN_PROCESSING_TERMS, expiresAt: input.action === "issue" ? expiresAt : null,
        // This consent authorizes a fixed evidence pipeline, never commands from captured speech.
        cloudTranscription: true, sourceMemory: true, knowledge: true, relationshipNotes: true,
        categories: true, citedFollowUps: true, executeCapturedInstructions: false } }, { sql });
  });
  if (input.action === "revoke") return { revoked: true as const };
  return { grant: { token, expiresAt, ingestUrl: `${origin}/api/mobile/listen/ingest`, ownerId: context.actorId,
    tenantId: context.tenantId, canonicalUserId: auth.userId, deviceId: native.deviceId, role: context.role,
    deploymentId: origin, apiOrigin: origin, terms: LISTEN_PROCESSING_TERMS } };
}

/** Only this upload route consumes Listen credentials. They are never accepted by normal bearer auth. */
export async function authorizeListenIngest(request: Request): Promise<ListenAuthority> {
  const token = /^Listen ([A-Za-z0-9_-]{64})$/.exec(request.headers.get("authorization") || "")?.[1];
  if (!token) throw new ListenError(401, "listen_access_required", "Open Listen in Asael to renew background access.");
  await requireListenDatabase();
  const origin = new URL(request.url).origin;
  const rows = await runWithDatabaseSystemScope("Resolve the exact hashed background recording grant before its tenant is known.", () => getSql()`
    SELECT g.*, u.email, t.name AS tenant_name, m.role, s.app_version, s.app_build_number,
      s.client_contract_version, s.client_attested_at
    FROM omni_listen_grants g
    JOIN omni_mobile_sessions s ON s.id = g.mobile_session_id AND s.tenant_id = g.tenant_id
      AND s.user_id = g.user_id AND s.device_id = g.device_id AND s.platform = 'android'
    JOIN omni_auth_users u ON u.id = g.user_id AND u.email = g.actor_id
    JOIN omni_auth_tenants t ON t.id = g.tenant_id
    JOIN omni_auth_memberships m ON m.user_id = g.user_id AND m.tenant_id = g.tenant_id AND m.role = g.actor_role
    WHERE g.token_sha256 = ${listenDigest(token)} AND g.api_origin = ${origin}
      AND g.revoked_at IS NULL AND g.expires_at > NOW() AND g.processing_terms = ${LISTEN_PROCESSING_TERMS}
      AND s.revoked_at IS NULL AND s.refresh_expires_at > NOW() AND s.client_contract_version >= 54
      AND u.status = 'active' AND m.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM omni_auth_memberships other_membership WHERE other_membership.user_id = g.user_id
        AND other_membership.tenant_id <> g.tenant_id AND other_membership.status = 'active')
    LIMIT 1`);
  const row = rows[0];
  if (!row || !privateAccountPolicyForIdentity({ email: String(row.email), tenantId: String(row.tenant_id), role: String(row.role) as SecurityRole })) {
    throw new ListenError(401, "listen_access_expired", "Open Listen in Asael to renew background access.");
  }
  const context: SecurityContext = { tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    role: String(row.role) as SecurityRole, source: "mobile",
    auth: { userId: String(row.user_id), email: String(row.email), sessionId: String(row.mobile_session_id), tenantName: String(row.tenant_name) },
    native: { deviceId: String(row.device_id), platform: "android", appVersion: String(row.app_version),
      buildNumber: Number(row.app_build_number), clientContractVersion: Number(row.client_contract_version),
      clientAttestedAt: new Date(String(row.client_attested_at)).toISOString() } };
  requirePermission(context, "write.memory");
  enterDatabaseSecurityContext(context);
  // A valid persistent grant deliberately outlives the foreground bearer and biometric UI lock.
  // Membership, role, session revocation, device and origin remain live authorization fences.
  return { context, grantId: String(row.id), origin };
}

export async function recordListenAdmission(authority: ListenAuthority, action: string, recordingId?: string) {
  await recordSecurityAudit({ context: authority.context, action: "write.memory", resourceType: "capture_recording",
    resourceId: recordingId, decision: "allow", metadata: { operation: `listen.${action}`, grantId: authority.grantId,
      processingTerms: LISTEN_PROCESSING_TERMS } });
}
