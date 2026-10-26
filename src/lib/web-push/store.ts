import "server-only";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { getSql, ensureDatabaseSchema, hasDatabaseUrl, runWithDatabaseSystemScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { withAvailabilityOwner, resolveAvailabilityOwner } from "@/lib/availability-watches/store";
import { AvailabilityWatchError, AvailabilityWatchProjectionSchema, availabilityOpeningActionable } from "@/lib/availability-watches/contracts";
import { findActiveNotificationOwnerPreferencesWithSql } from "@/lib/mobile/notification-owner";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import type { SecurityContext } from "@/lib/security/types";
import { credentialBinding, sealCredentialBundle, openCredentialBundle } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { browserSubscriptionSchema } from "./contracts";

type Owner = { tenantId: string; actorId: string };
const digest = canonicalJsonSha256;
const error = (message: string, status = 409) => new AvailabilityWatchError(message, status, "browser_alert_unavailable");
export function browserPushConfiguration() {
  const publicKey = process.env.OMNIAGENT_WEB_PUSH_PUBLIC_KEY?.trim();
  const configured = Boolean(publicKey && process.env.OMNIAGENT_WEB_PUSH_PRIVATE_KEY?.trim() && process.env.OMNIAGENT_WEB_PUSH_SUBJECT?.trim());
  return { configured, publicKey: configured ? publicKey! : null };
}
function binding(owner: Owner, id: string) {
  return credentialBinding({ ...owner, connectionId: id, provider: "browser_push", credentialVersion: 1 });
}
function requestOwner(context: SecurityContext) {
  const actor = canonicalRequestActorBindingFromSecurityContext(context);
  if (context.source !== "session" || !actor || !context.auth) throw error("Sign in to Asael in this browser to manage its alerts.", 403);
  return { tenantId: context.tenantId, actorId: actor.canonicalActorId, userId: context.auth.userId, sessionId: context.auth.sessionId };
}
async function session(sql: SqlClient, owner: Owner & { userId: string; sessionId: string }) {
  await resolveAvailabilityOwner(sql, owner);
  const rows = await sql`SELECT id FROM omni_auth_sessions WHERE id = ${owner.sessionId} AND user_id = ${owner.userId}
    AND tenant_id = ${owner.tenantId} AND expires_at > clock_timestamp() FOR SHARE`;
  if (rows.length !== 1) throw error("Sign in again to enable browser alerts.", 403);
}
export async function listBrowserPush(context: SecurityContext) {
  const owner = requestOwner(context);
  return withAvailabilityOwner(owner, async sql => {
    await session(sql, owner);
    const rows = await sql`SELECT id,state,updated_at FROM omni_web_push_registrations
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND session_id = ${owner.sessionId} ORDER BY updated_at DESC LIMIT 20`;
    return { ...browserPushConfiguration(), registrations: rows.map(row => ({ id: String(row.id), state: String(row.state) })) };
  });
}
export async function registerBrowserPush(context: SecurityContext, input: unknown) {
  const owner = requestOwner(context), subscription = browserSubscriptionSchema.parse(input);
  if (!browserPushConfiguration().configured) throw error("Browser delivery has not been configured.", 503);
  const endpointHash = digest(subscription.endpoint), id = `web_registration_${digest([owner.tenantId, owner.actorId, endpointHash]).slice(0,48)}`;
  const sealed = sealCredentialBundle({ subscription: JSON.stringify(subscription) }, binding(owner, id));
  return withAvailabilityOwner(owner, async sql => {
    await session(sql, owner);
    // One endpoint per owner, rebinding only to this owner's current session.
    const counts = await sql`SELECT COUNT(*)::int AS count FROM omni_web_push_registrations WHERE tenant_id = ${owner.tenantId}
      AND actor_id = ${owner.actorId} AND state = 'active' AND id <> ${id}`;
    if (Number(counts[0]?.count) >= 20) throw error("Disable an old browser before adding another.");
    await sql`INSERT INTO omni_web_push_registrations(id,tenant_id,actor_id,user_id,session_id,endpoint_sha256,subscription,state)
      VALUES (${id},${owner.tenantId},${owner.actorId},${owner.userId},${owner.sessionId},${endpointHash},${sealed}::jsonb,'active')
      ON CONFLICT (tenant_id,actor_id,endpoint_sha256) DO UPDATE SET session_id = EXCLUDED.session_id,subscription = EXCLUDED.subscription,state = 'active',updated_at = clock_timestamp()`;
    await sql`UPDATE omni_web_push_registrations SET state = 'revoked',updated_at = clock_timestamp() WHERE tenant_id = ${owner.tenantId}
      AND actor_id = ${owner.actorId} AND session_id = ${owner.sessionId} AND id <> ${id} AND state = 'active'`;
    await event(sql, owner, id, "registered");
    return { id, state: "active" };
  });
}
export async function revokeBrowserPush(context: SecurityContext, id: string) {
  const owner = requestOwner(context);
  return withAvailabilityOwner(owner, async sql => {
    await session(sql, owner);
    const rows = await sql`UPDATE omni_web_push_registrations SET state = 'revoked',updated_at = clock_timestamp()
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND session_id = ${owner.sessionId} AND id = ${id} RETURNING id`;
    if (rows.length !== 1) throw error("This browser registration is unavailable.", 404);
    await event(sql, owner, id, "revoked"); return { id, state: "revoked" };
  });
}
/** Same transaction as the Inbox item; no transport claims before provider IO. */
export async function enqueueBrowserWatchPush(sql: SqlClient, owner: Owner, notificationId: string, openingId: string, expiresAt: string) {
  if (!sql.transactionScoped) throw error("Browser notification enqueue requires a transaction.", 503);
  const rows = await sql`SELECT registration.id,registration.session_id FROM omni_web_push_registrations registration
    JOIN omni_auth_sessions session ON session.id = registration.session_id AND session.user_id = registration.user_id AND session.tenant_id = registration.tenant_id
    WHERE registration.tenant_id = ${owner.tenantId} AND registration.actor_id = ${owner.actorId} AND registration.state = 'active' AND session.expires_at > clock_timestamp()`;
  for (const row of rows) await enqueue(sql, owner, row, { notificationId, occurrenceKey: openingId, expiresAt, kind: "watch" });
}
export async function enqueueBrowserSelfImprovementPush(sql: SqlClient, owner: Owner, notificationId: string, eventId: string, expiresAt: string) {
  if (!sql.transactionScoped) throw error("Browser notification enqueue requires a transaction.", 503);
  const rows = await sql`SELECT registration.id,registration.session_id FROM omni_web_push_registrations registration
    JOIN omni_auth_sessions session ON session.id=registration.session_id AND session.user_id=registration.user_id AND session.tenant_id=registration.tenant_id
    WHERE registration.tenant_id=${owner.tenantId} AND registration.actor_id=${owner.actorId} AND registration.state='active' AND session.expires_at>clock_timestamp()`;
  for (const row of rows) await enqueue(sql, owner, row, { notificationId, occurrenceKey: eventId, expiresAt, kind: "self_improvement" });
}
async function enqueue(sql: SqlClient, owner: Owner, registration: SqlRow, value: { notificationId: string | null; occurrenceKey: string; expiresAt: string; kind: "watch" | "test" | "self_improvement" }) {
  const id = `web_delivery_${digest([owner.tenantId,owner.actorId,registration.id,value.occurrenceKey]).slice(0,48)}`;
  await sql`INSERT INTO omni_web_push_deliveries(id,tenant_id,actor_id,registration_id,session_id,notification_id,occurrence_key,kind,expires_at)
    VALUES (${id},${owner.tenantId},${owner.actorId},${registration.id},${registration.session_id},${value.notificationId},${value.occurrenceKey},${value.kind},${value.expiresAt})
    ON CONFLICT (tenant_id,actor_id,registration_id,occurrence_key) DO NOTHING`;
  return id;
}
export async function queueBrowserPushTest(context: SecurityContext, registrationId: string, requestId: string) {
  const owner = requestOwner(context);
  return withAvailabilityOwner(owner, async sql => {
    await session(sql, owner);
    const rows = await sql`SELECT id,session_id FROM omni_web_push_registrations WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      AND id = ${registrationId} AND session_id = ${owner.sessionId} AND state = 'active' FOR UPDATE`;
    if (rows.length !== 1) throw error("Enable alerts in this browser first.");
    const key = `test:${digest(requestId)}`;
    const recent = await sql`SELECT occurrence_key FROM omni_web_push_deliveries WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      AND registration_id = ${registrationId} AND kind = 'test' AND created_at > clock_timestamp() - interval '1 minute'`;
    if (recent.some(row => row.occurrence_key !== key)) throw error("Wait one minute before sending another test alert.", 429);
    const id = await enqueue(sql,owner,rows[0],{ notificationId:null,occurrenceKey:key,expiresAt:new Date(Date.now()+300_000).toISOString(),kind:"test" });
    await event(sql,owner,id,"test_queued"); return { id, state:"queued" };
  });
}
async function currentPresentation(sql: SqlClient, owner: Owner, row: SqlRow) {
  const preferences = await findActiveNotificationOwnerPreferencesWithSql(sql, owner.tenantId, owner.actorId);
  if (!preferences?.notificationsEnabled) throw error("Account notifications are disabled.");
  if (row.kind === "test") return { title:"Asael — test alert", body:"Browser alerts are working. This is not a booking opening.", href:"/app/watches" };
  if (row.kind === "self_improvement") {
    const notices = await sql`SELECT notice.title FROM omni_personal_notifications notice
      JOIN omni_self_improvement_cycles cycle ON cycle.id=notice.source_id AND cycle.tenant_id=notice.tenant_id AND cycle.owner_actor_id=notice.actor_id
      JOIN omni_events event ON event.id=notice.occurrence_key AND event.tenant_id=notice.tenant_id AND event.actor_id=notice.actor_id
      WHERE notice.id=${row.notification_id} AND notice.tenant_id=${owner.tenantId} AND notice.actor_id=${owner.actorId}
        AND notice.kind='self_improvement' AND notice.source_type='self_improvement' AND notice.status='unread'
        AND notice.occurrence_key=${row.occurrence_key} AND event.payload->>'stage'=cycle.stage
        AND ((event.type='self_improvement.cycle.updated' AND cycle.stage IN ('succeeded','failed','rolled_back','review_required'))
          OR (event.type='self_improvement.release.held' AND cycle.stage IN ('ready_for_release','releasing')
            AND cycle.controller_hold->>'category'=event.payload->>'category'
            AND (cycle.controller_hold->>'occurredAt')::timestamptz=event.at)
              OR (event.type='self_improvement.native_validation.held' AND cycle.stage IN ('planned','validating')
                AND cycle.runtime->'native'->>'activeRequestId'=event.payload->>'requestId'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(cycle.runtime->'native'->'requests','[]'::jsonb)) entry
                  WHERE entry->'request'->>'requestId'=event.payload->>'requestId'
                    AND entry->'request'->>'requestSha256'=event.payload->>'requestSha256'
                    AND entry->>'status'='held' AND entry->>'holdCategory'=event.payload->>'category')))
            AND event.payload->>'cycleId'=cycle.id AND cycle.snapshot->'policy'->>'notifyOutcomes'='true'
      FOR SHARE OF cycle`;
    if (notices.length !== 1) throw error("This improvement alert is no longer actionable.");
    return { title: "Asael", body: String(notices[0].title), href: "/app/improvement" };
  }
  const watch = await sql`SELECT watch.id,watch.snapshot,clock_timestamp() AS checked_at FROM omni_availability_watches watch JOIN omni_personal_notifications notice
    ON notice.tenant_id = watch.tenant_id AND notice.actor_id = watch.actor_id AND notice.source_id = watch.id
    WHERE watch.tenant_id = ${owner.tenantId} AND watch.actor_id = ${owner.actorId} AND notice.id = ${row.notification_id}
      AND notice.kind = 'availability_watch' AND notice.source_type = 'availability_watch' AND notice.status = 'unread'
      AND watch.state = 'fulfilled' AND watch.expires_at > clock_timestamp()
      AND watch.snapshot->>'openingId' = notice.occurrence_key AND notice.occurrence_key = ${row.occurrence_key}
    FOR SHARE OF watch`;
  if (watch.length !== 1 || !availabilityOpeningActionable(AvailabilityWatchProjectionSchema.parse(watch[0].snapshot),
    new Date(watch[0].checked_at as string | Date).toISOString())) throw error("The booking alert is no longer actionable.");
  return { title:"Asael",body:"A matching booking is available. Open Asael to view the details.",href:`/app/watches/${watch[0].id}` };
}
/** Exact session binding also prevents a delayed push from exposing another signed-in account. */
export async function browserDelivery(context: SecurityContext, id: string, receipt?: "received" | "opened") {
  const owner = requestOwner(context);
  return withAvailabilityOwner(owner, async sql => {
    await session(sql,owner);
    const rows = await sql`SELECT delivery.* FROM omni_web_push_deliveries delivery JOIN omni_web_push_registrations registration
      ON registration.id = delivery.registration_id AND registration.tenant_id = delivery.tenant_id AND registration.actor_id = delivery.actor_id
      WHERE delivery.id = ${id} AND delivery.tenant_id = ${owner.tenantId} AND delivery.actor_id = ${owner.actorId}
        AND delivery.session_id = ${owner.sessionId} AND registration.session_id = ${owner.sessionId} AND registration.state = 'active'
        AND delivery.state IN ('running','accepted') AND delivery.expires_at > clock_timestamp() FOR UPDATE OF delivery`;
    if (rows.length !== 1) throw error("This browser alert is unavailable.",404);
    const row = rows[0], presentation = await currentPresentation(sql,owner,row);
    if (receipt) {
      if (receipt === "received") await sql`UPDATE omni_web_push_deliveries SET received_at = COALESCE(received_at,clock_timestamp()),updated_at = clock_timestamp() WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
      else await sql`UPDATE omni_web_push_deliveries SET opened_at = COALESCE(opened_at,clock_timestamp()),updated_at = clock_timestamp() WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
      await event(sql,owner,id,receipt); return { ...presentation,display: false };
    }
    return { ...presentation,display: !row.received_at };
  });
}
export async function dispatchBrowserPush(input: { limit?: number; deadlineAt?: number } = {}) {
  if (!hasDatabaseUrl() || !browserPushConfiguration().configured) return { processed:0 };
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseSystemScope("Enumerate bounded browser alert owner coordinates.", () => getSql()`
    SELECT tenant_id,actor_id,id FROM omni_web_push_deliveries WHERE (state = 'queued' AND due_at <= clock_timestamp())
      OR (state = 'running' AND lease_expires_at <= clock_timestamp()) ORDER BY due_at,id LIMIT ${Math.min(10,input.limit || 5)}`);
  let processed = 0;
  for (const coordinate of rows) {
    if (Date.now()+6_000 > (input.deadlineAt ?? Infinity)) break;
    const owner = { tenantId:String(coordinate.tenant_id), actorId:String(coordinate.actor_id) }, id = String(coordinate.id), lease = randomUUID();
    await withAvailabilityOwner(owner, async sql => {
      const claimed = await sql`UPDATE omni_web_push_deliveries SET state = 'running',lease_id = ${lease},lease_expires_at = clock_timestamp()+interval '30 seconds',updated_at = clock_timestamp()
        WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
          AND ((state = 'queued' AND due_at <= clock_timestamp()) OR (state = 'running' AND lease_expires_at <= clock_timestamp())) RETURNING *`;
      if (!claimed.length) return;
      const row = claimed[0];
      // Commit the claim before IO, retaining a bounded recoverable lease.
      return row;
    }).then(async row => {
      if (!row) return;
      let failure = "provider_unavailable", accepted = false, permanent = false;
      try {
        await withAvailabilityOwner(owner, async sql => {
          const registrations = await sql`SELECT * FROM omni_web_push_registrations WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
            AND id = ${row.registration_id} AND session_id = ${row.session_id} AND state = 'active' FOR SHARE`;
          if (registrations.length !== 1 || new Date(String(row.expires_at)).getTime() <= Date.now() || Number(row.attempts) >= 4) throw error("Delivery expired or its browser was disabled.");
          const registration = registrations[0];
          await session(sql,{ ...owner,userId:String(registration.user_id),sessionId:String(row.session_id) });
          await currentPresentation(sql,owner,row);
          const subscription = browserSubscriptionSchema.parse(JSON.parse(openCredentialBundle(registration.subscription,binding(owner,String(registration.id))).subscription));
          const request = webpush.generateRequestDetails(subscription,JSON.stringify({ version:1,id }),{
            TTL:Math.max(1,Math.min(300,Math.floor((new Date(String(row.expires_at)).getTime()-Date.now())/1000))), urgency:"high",topic:id.slice(-32),
            vapidDetails:{ subject:process.env.OMNIAGENT_WEB_PUSH_SUBJECT!,publicKey:process.env.OMNIAGENT_WEB_PUSH_PUBLIC_KEY!,privateKey:process.env.OMNIAGENT_WEB_PUSH_PRIVATE_KEY! },
          });
          const response = await fetchPublicHttpUrl(subscription.endpoint,{ method:"POST",headers:request.headers as Record<string,string>,body:new Uint8Array(request.body!),redirect:"manual",credentials:"omit",signal:AbortSignal.timeout(5_000) },"Browser push provider");
          void response.body?.cancel(); accepted = response.status === 201 || response.status === 202;
          if (!accepted) {
            failure = `provider_http_${response.status}`; permanent = [400,401,403,404,410].includes(response.status);
            if ([404,410].includes(response.status)) await sql`UPDATE omni_web_push_registrations SET state = 'revoked',updated_at = clock_timestamp() WHERE id = ${registration.id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
          }
        });
      } catch (caught) { if (caught instanceof AvailabilityWatchError) { permanent = true; failure = "delivery_no_longer_authorized"; } }
      await withAvailabilityOwner(owner, async sql => {
        const attempts = Math.min(4,Number(row.attempts)+1), state = accepted ? "accepted" : permanent || attempts >= 4 ? "failed" : "queued";
        await sql`UPDATE omni_web_push_deliveries SET state = ${state},attempts = ${attempts},accepted_at = CASE WHEN ${accepted} THEN clock_timestamp() ELSE accepted_at END,
          due_at = clock_timestamp()+interval '1 minute',failure_code = ${accepted ? null : failure},lease_id = NULL,lease_expires_at = NULL,updated_at = clock_timestamp()
          WHERE id = ${id} AND tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND lease_id = ${lease}`;
        await event(sql,owner,id,accepted ? "provider_accepted" : state === "failed" ? "failed" : "retry_queued");
      });
      processed++;
    });
  }
  return { processed };
}
async function event(sql: SqlClient, owner: Owner, id: string, action: string) {
  await appendScopedDomainEvent({ id:`browser-push:${randomUUID()}`,streamId:`browser-push:${owner.tenantId}:${id}`,type:`browser_push.${action}`,
    executionScope:createExecutionScope({ tenantId:owner.tenantId,initiatingActorId:owner.actorId,executingPrincipalType:"system",executingPrincipalId:"browser-push",correlationId:id,purpose:`browser_push.${action}` }),
    payload:{ id,action } },{ sql });
}
