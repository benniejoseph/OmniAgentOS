import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";

type Sql = ReturnType<typeof getSql>;
export async function assertCaptureNativeProcessingFence(sql: Sql, input: { tenantId: string; actorId: string; recordingId: string; nativeAcceptanceId?: string }) {
  // Shared with native admission: neither a legacy retry nor a new native key
  // can replace the head/queue after the reviewed source has been accepted.
  let recordingActorId = input.actorId;
  if (input.nativeAcceptanceId) {
    const accepted = await sql`SELECT owner_actor_id,canonical_actor_id FROM omni_meeting_recording_processing_acceptances
      WHERE id=${input.nativeAcceptanceId} AND tenant_id=${input.tenantId} AND recording_id=${input.recordingId}
        AND (owner_actor_id=${input.actorId} OR canonical_actor_id=${input.actorId})
        AND public.omni_native_private_memory_owner_v1(tenant_id,owner_actor_id,canonical_actor_id,TRUE)`;
    if (accepted.length !== 1) throw new Error("Native media ownership requires its exact current accepted recording.");
    recordingActorId = String(accepted[0].owner_actor_id);
  }
  await sql`SELECT id FROM omni_capture_recordings WHERE tenant_id=${input.tenantId} AND actor_id=${recordingActorId} AND id=${input.recordingId} FOR UPDATE`;
  const rows = await sql`SELECT id FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${input.tenantId}
    AND owner_actor_id=${recordingActorId} AND recording_id=${input.recordingId}`;
  if (rows.length ? rows.length !== 1 || rows[0].id !== input.nativeAcceptanceId : input.nativeAcceptanceId !== undefined) {
    throw new Error("This recording is bound to an exact native processing acceptance; automatic restart is unavailable.");
  }
}
export async function withCaptureNativeProcessingFence<T>(input: { tenantId: string; actorId: string; recordingId: string }, work: () => Promise<T>) {
  if (!hasDatabaseUrl()) return work();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(input.tenantId, [input.actorId], () => getSql().transaction(async (transaction: Sql) => runWithManagedDatabaseTransaction(transaction, async () => {
    await assertCaptureNativeProcessingFence(getSql(), input); return work();
  })) as Promise<T>);
}
/** Existing legacy worker jobs are already running before this read, and
 * native admission refuses those leases. No provider call crosses the fence. */
export async function requireLegacyCaptureProcessing(recordingId: string, owner: { tenantId: string; actorId: string }) {
  if (!hasDatabaseUrl()) return;
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseActorScope(owner.tenantId, [owner.actorId], () => getSql()`SELECT id FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${owner.tenantId}
    AND owner_actor_id=${owner.actorId} AND recording_id=${recordingId}`);
  if (rows.length) throw new Error("Native recording processing requires its exact accepted worker reference.");
}
