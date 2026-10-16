import { randomUUID,randomBytes,createECDH } from "node:crypto";
import postgres from "postgres";
import webpush from "web-push";
import { beforeAll,afterAll,describe,it,expect,vi } from "vitest";
import { ensureDatabaseSchema,closeDatabaseClient } from "@/lib/db/client";
import { registerBrowserPush,queueBrowserPushTest,dispatchBrowserPush,browserDelivery,revokeBrowserPush } from "@/lib/web-push/store";
import { createAvailabilityWatch,stopAvailabilityWatch } from "@/lib/availability-watches/service";
import { getAvailabilityWatchReadiness } from "@/lib/availability-watches/readiness";
import { admitAvailabilityWatchOpeningWithSql } from "@/lib/availability-watches/notifications";
import { withAvailabilityOwner,readAvailabilityHead,saveAvailabilityHead } from "@/lib/availability-watches/store";
import type { SecurityContext } from "@/lib/security/types";
const network=vi.hoisted(()=>({send:vi.fn(async()=>new Response(null,{status:201}))}));
vi.mock("@/lib/security/network",()=>({fetchPublicHttpUrl:network.send}));
const databaseUrl=process.env.DATABASE_URL;
const allowed=databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" &&
  new URL(databaseUrl).hostname === "127.0.0.1" && new URL(databaseUrl).pathname === "/watch_candidate_synthetic";
const suite=allowed ? describe : describe.skip;
suite("candidate watch / browser delivery against isolated PostgreSQL",()=>{
  let admin:ReturnType<typeof postgres>;
  const user=randomUUID(),tenant=`watch-candidate-${randomUUID()}`,email=`${user}@example.test`,actor=`actor:${user}`,sessionId=randomUUID();
  const owner={tenantId:tenant,actorId:actor};
  const context:SecurityContext={tenantId:tenant,actorId:email,source:"session",role:"admin",auth:{userId:user,email,sessionId,tenantName:"Synthetic delivery validation"}};
  const ecdh=createECDH("prime256v1");ecdh.generateKeys();
  const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/synthetic-candidate",expirationTime:null,keys:{p256dh:ecdh.getPublicKey().toString("base64url"),auth:randomBytes(16).toString("base64url")}};
  beforeAll(async()=>{
    await closeDatabaseClient();
    admin=postgres(databaseUrl!,{max:1,prepare:false,ssl:false,onnotice:()=>undefined});
    await admin`DROP SCHEMA public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const keys=webpush.generateVAPIDKeys();
    vi.stubEnv("OMNIAGENT_WEB_PUSH_PUBLIC_KEY",keys.publicKey);vi.stubEnv("OMNIAGENT_WEB_PUSH_PRIVATE_KEY",keys.privateKey);vi.stubEnv("OMNIAGENT_WEB_PUSH_SUBJECT","https://asael.example");
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING",JSON.stringify({activeKeyId:"candidate",keys:{candidate:randomBytes(32).toString("base64url")}}));
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenant},'Synthetic delivery validation',${tenant})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenant},${user},'admin')`;
    await admin`INSERT INTO omni_auth_sessions(id,user_id,tenant_id,token_hash,expires_at) VALUES(${sessionId},${user},${tenant},${randomBytes(32).toString('hex')},NOW()+interval '1 hour')`;
    await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,timezone,notifications_enabled,quiet_hours_enabled,quiet_hours_start,quiet_hours_end)
      VALUES(${tenant},${actor},'UTC',true,true,'00:00','23:59')`;
  },180_000);
  afterAll(async()=>{await closeDatabaseClient();await admin?.end();vi.unstubAllEnvs();});
  it("persists one test delivery on replay, distinguishes acceptance from receipt and blocks after sign-out",async()=>{
    const registration=await registerBrowserPush(context,subscription),key=randomUUID();
    const first=await queueBrowserPushTest(context,registration.id,key),replay=await queueBrowserPushTest(context,registration.id,key);
    expect(replay.id).toBe(first.id);
    expect(await dispatchBrowserPush({limit:1})).toEqual({processed:1});
    expect(network.send).toHaveBeenCalledOnce();
    expect((await admin`SELECT state,received_at FROM omni_web_push_deliveries WHERE id=${first.id}`)[0]).toMatchObject({state:"accepted",received_at:null});
    expect(await browserDelivery(context,first.id)).toMatchObject({display:true,title:"Asael — test alert"});
    await browserDelivery(context,first.id,"received");
    expect(await browserDelivery(context,first.id)).toMatchObject({display:false});
    await browserDelivery(context,first.id,"opened");
    await expect(browserDelivery({...context,auth:{...context.auth!,sessionId:"other-session"}},first.id)).rejects.toMatchObject({status:403});
    await revokeBrowserPush(context,registration.id);
    await expect(browserDelivery(context,first.id)).rejects.toMatchObject({status:404});
  });
  it("records a time-sensitive opening once, co-commits browser delivery, exposes source/readiness and honors stop",async()=>{
    const registration=await registerBrowserPush(context,subscription);
    const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
    const watch=await createAvailabilityWatch({source:{provider:"district",cinemaId:"1022272",cinemaName:"Synthetic PVR VR Mall",sourceUrl:"https://www.district.in/movies/pvr-vr-whitefield-road-bengaluru-CD1022272"},
      target:{date,timezone:"Asia/Kolkata",movieTitle:"Synthetic Jailer 2",language:"Tamil",seatClass:"gold",latestTime:"12:00"},intervalMinutes:1}, {...owner,requestId:randomUUID()});
    const openingId=`availability-opening:${'b'.repeat(64)}`,observedAt=new Date().toISOString();
    const notice=await withAvailabilityOwner(owner,async sql=>{
      const head=(await readAvailabilityHead(sql,owner,watch.id))!;
      const admission=await admitAvailabilityWatchOpeningWithSql(sql,{...owner,watchId:watch.id,generation:1,openingId,observedAt,title:"Synthetic booking opening — candidate validation only",expiresAt:watch.config.expiresAt});
      expect(admission.state).toBe("recorded");
      const matches=[{sessionId:"synthetic-session",movieTitle:"Synthetic Jailer 2",language:"Tamil",format:"2D",startsAt:new Date(`${date}T10:00:00+05:30`).toISOString(),localTime:"10:00",seatClass:"GOLD",availableSeats:3,price:100,currency:"INR" as const,bookingUrl:"https://www.district.in/movies/pvr-vr-whitefield-road-bengaluru-CD1022272"}];
      await saveAvailabilityHead(sql,owner,{watch:{...head.watch,revision:2,state:"fulfilled",openingId,matches,notification:admission,nextCheckAt:null,updatedAt:observedAt},pendingCheckId:null},1);
      return admission;
    });
    const readiness=await getAvailabilityWatchReadiness(watch.id,owner);
    expect(readiness.sourceUrl).toContain(`fromdate=${date}`);expect(readiness.browser).toMatchObject({eligible:1,queued:1,accepted:0,received:0});
    const deliveries=await admin`SELECT id FROM omni_web_push_deliveries WHERE registration_id=${registration.id} AND notification_id=${notice.notificationId}`;
    expect(deliveries).toHaveLength(1);
    await withAvailabilityOwner(owner,async sql=>admitAvailabilityWatchOpeningWithSql(sql,{...owner,watchId:watch.id,generation:1,openingId,observedAt,title:"Synthetic booking opening — candidate validation only",expiresAt:watch.config.expiresAt}));
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenant} AND source_id=${watch.id}`).toHaveLength(1);
    await stopAvailabilityWatch(watch.id,{...owner,expectedRevision:2,requestId:randomUUID()});
    const before=network.send.mock.calls.length;
    await dispatchBrowserPush({limit:5});
    expect(network.send.mock.calls.length).toBe(before);
    expect((await admin`SELECT state FROM omni_web_push_deliveries WHERE id=${deliveries[0].id}`)[0].state).toBe("failed");
  });
  it("honors notifications-off at provider dispatch and validates the live web session",async()=>{
    const registration=await registerBrowserPush(context,subscription);
    const before=network.send.mock.calls.length;
    const previous=await admin`SELECT occurrence_key FROM omni_web_push_deliveries WHERE registration_id=${registration.id} AND kind='test'`;
    await admin`UPDATE omni_web_push_deliveries SET created_at=NOW()-interval '2 minutes' WHERE registration_id=${registration.id} AND kind='test'`;
    expect(previous).toHaveLength(1);
    const test=await queueBrowserPushTest(context,registration.id,randomUUID());
    await admin`UPDATE omni_today_preferences SET notifications_enabled=false WHERE tenant_id=${tenant} AND actor_id=${actor}`;
    await dispatchBrowserPush({limit:5});
    expect(network.send.mock.calls.length).toBe(before);
    expect((await admin`SELECT state FROM omni_web_push_deliveries WHERE id=${test.id}`)[0].state).toBe("failed");
    await admin`UPDATE omni_today_preferences SET notifications_enabled=true WHERE tenant_id=${tenant} AND actor_id=${actor}`;
    await admin`DELETE FROM omni_auth_sessions WHERE id=${sessionId}`;
    await expect(registerBrowserPush(context,subscription)).rejects.toMatchObject({status:403});
  });
  it("denies another actor's registration and delivery rows under the runtime role",async()=>{
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    const counts=await admin.begin(async sql=>{
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`SELECT set_config('omni.system_scope','false',true),set_config('omni.tenant_id',${tenant},true),set_config('omni.actor_scope_v1',${JSON.stringify({version:1,tenantId:tenant,actorIds:[`actor:${randomUUID()}`]})},true)`;
      return await sql`SELECT (SELECT count(*) FROM omni_web_push_registrations)::int AS registrations,(SELECT count(*) FROM omni_web_push_deliveries)::int AS deliveries`;
    });
    expect(counts[0]).toEqual({registrations:0,deliveries:0});
  });
});
