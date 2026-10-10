import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { privateAccountPolicyForIdentity } from "@/lib/auth/private-account-policy";
import { linkCsmSource, showCsmProject } from "@/lib/csm/service";
import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { deriveExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext, SecurityRole } from "@/lib/security/types";
import { getCaptureRecording } from "./recordings";
import { LISTEN_PROCESSING_TERMS } from "./listen-contracts";

/** The accepted user selection is the only client routing input. Model output cannot choose a client. */
export async function linkProcessedListenClient(input: { tenantId: string; actorId: string; recordingId: string;
  executionScope: ExecutionScope }) {
  const recording = await getCaptureRecording(input.recordingId, input);
  if (!recording || recording.metadata.listen !== true || typeof recording.metadata.projectId !== "string" ||
    recording.metadata.processingTerms !== LISTEN_PROCESSING_TERMS) return { status: "not_requested" as const };
  const projectId = recording.metadata.projectId;
  const executionScope = deriveExecutionScope(input.executionScope, { purpose: "listen.client.source.link", projectId });
  let status: "linked" | "needs_attention" = "needs_attention";
  try {
    const rows = await getSql()`SELECT u.id, u.email, t.name AS tenant_name, m.role
      FROM omni_auth_users u JOIN omni_auth_memberships m ON m.user_id = u.id
      JOIN omni_auth_tenants t ON t.id = m.tenant_id
      WHERE u.id = ${String(recording.metadata.listenAuthUserId || "")} AND u.email = ${input.actorId}
        AND m.tenant_id = ${input.tenantId} AND u.status = 'active' AND m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM omni_auth_memberships other_membership WHERE other_membership.user_id = u.id
          AND other_membership.tenant_id <> m.tenant_id AND other_membership.status = 'active') LIMIT 1`;
    const row = rows[0];
    if (!row || !privateAccountPolicyForIdentity({ email: String(row.email), tenantId: input.tenantId,
      role: String(row.role) as SecurityRole })) throw new Error("Owner authority changed.");
    // Rehydrate only the accepted caller identity. All project/source permissions are checked again by the service.
    const context: SecurityContext = { tenantId: input.tenantId, actorId: input.actorId, role: String(row.role) as SecurityRole,
      source: "mobile", auth: { userId: String(row.id), email: String(row.email),
        sessionId: `listen-processing:${recording.id}`, tenantName: String(row.tenant_name) } };
    const binding = canonicalRequestActorBindingFromSecurityContext(context);
    if (!binding || binding.canonicalActorId !== recording.metadata.listenCanonicalActorId) throw new Error("Owner identity changed.");
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: `listen-client:${recording.id}` });
    await runWithDatabaseActorScope(input.tenantId, binding.readableOwnerActorIds, async () => {
      const current = await showCsmProject(caller, projectId);
      const libraryItemId = `library:capture_transcript:${recording.id}`;
      if (current.data.sourceLinks.some(link => link.libraryItemId === libraryItemId && link.status === "current")) {
        status = "linked"; return;
      }
      if (!current.data.profile || !current.data.revision) throw new Error("Client brief unavailable.");
      await linkCsmSource(caller, projectId, { libraryItemId, expectedRevision: current.data.revision });
      status = "linked";
    });
  } catch {
    // A private recording remains available even when a client was archived or its source list became full.
    status = "needs_attention";
  }
  await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    await sql`UPDATE omni_listen_sources SET client_context_status = ${status}
      WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} AND recording_id = ${input.recordingId}
        AND tombstoned_at IS NULL`;
    await appendScopedDomainEvent({ streamId: `listen-recording:${input.recordingId}`, type: "listen.client_context.updated",
      executionScope, payload: { schemaVersion: 1, recordingId: input.recordingId, projectId, status } }, { sql });
  });
  return { status };
}
