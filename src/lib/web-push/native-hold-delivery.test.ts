import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
const state = vi.hoisted(() => ({ current:true,enabled:true, statements:[] as string[], sql:vi.fn(), network:vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/db/client",()=>({getSql:()=>state.sql,ensureDatabaseSchema:async()=>undefined,hasDatabaseUrl:()=>true,runWithDatabaseSystemScope:(_reason:string,work:()=>unknown)=>work()}));
vi.mock("@/lib/availability-watches/store",()=>({resolveAvailabilityOwner:async()=>undefined,withAvailabilityOwner:(_owner:unknown,work:(sql:unknown)=>unknown)=>work(state.sql)}));
vi.mock("@/lib/mobile/notification-owner",()=>({findActiveNotificationOwnerPreferencesWithSql:async()=>({notificationsEnabled:state.enabled})}));
vi.mock("@/lib/security/network",()=>({fetchPublicHttpUrl:state.network}));
vi.mock("@/lib/events/store",()=>({appendScopedDomainEvent:vi.fn()}));
import { browserDelivery } from "./store";
const cycleId = `self_cycle_${"a".repeat(64)}`;
const context = {source:"session",tenantId:"tenant-one",actorId:"owner@example.test",role:"admin",
  auth:{userId:"00000000-0000-4000-8000-000000000001",email:"owner@example.test",sessionId:"session-one"}} as unknown as SecurityContext;
describe("browser held native check revalidation",()=>{
  beforeEach(()=>{
    vi.clearAllMocks(); state.current=true; state.enabled=true; state.statements=[];
    state.sql.mockImplementation(async(strings:TemplateStringsArray)=>{
      const query=strings.join("?"); state.statements.push(query);
      if(query.includes("SELECT id FROM omni_auth_sessions"))return [{id:"session-one"}];
      if(query.includes("SELECT delivery.*"))return [{kind:"self_improvement",notification_id:"notice-one",occurrence_key:`${cycleId}:12:native`,received_at:null}];
      if(query.includes("SELECT notice.title"))return state.current?[{title:"Asael’s Mac check needs attention"}]:[];
      return [];
    });
  });
  it("returns only the current exact held check presentation",async()=>{
    expect(await browserDelivery(context,"delivery-one")).toEqual({title:"Asael",body:"Asael’s Mac check needs attention",href:"/app/improvement",display:true});
    const query=state.statements.find(item=>item.includes("SELECT notice.title"))!;
    expect(query).toContain("self_improvement.native_validation.held");
    expect(query).toContain("cycle.runtime->'native'->>'activeRequestId'=event.payload->>'requestId'");
    expect(query).toContain("entry->'request'->>'requestSha256'=event.payload->>'requestSha256'");
    expect(query).toContain("entry->>'status'='held'");
    expect(query).toContain("entry->>'holdCategory'=event.payload->>'category'");
    expect(state.network).not.toHaveBeenCalled();
  });
  it("refuses resolved, stopped, replaced or disabled occurrences before browser display",async()=>{
    state.current=false;
    await expect(browserDelivery(context,"delivery-one")).rejects.toThrow(/no longer actionable/);
    state.current=true;state.enabled=false;
    await expect(browserDelivery(context,"delivery-one")).rejects.toThrow(/disabled/);
    expect(state.network).not.toHaveBeenCalled();
  });
});
