import { describe,it,expect,vi } from "vitest";
import { browserPushWorkerScript } from "./worker";
import { isBrowserPushEndpoint } from "./contracts";
function harness(network: (url:string,options?:RequestInit) => Promise<Response>) {
  const handlers = new Map<string,(event:unknown) => void>();
  const shown = vi.fn(async () => undefined), open = vi.fn(async () => undefined);
  const self = { location:{ origin:"https://asael.example" },addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn),
    registration:{ getNotifications:vi.fn(async()=>[]),showNotification:shown },clients:{ matchAll:vi.fn(async()=>[]),openWindow:open } };
  const fetch = vi.fn(network);
  new Function("self","fetch",browserPushWorkerScript)(self,fetch);
  const fire = async (name:string,data:unknown) => { const promises:Promise<unknown>[]=[];
    handlers.get(name)?.({ data:{ json:()=>data },notification:{ data,close:vi.fn() },waitUntil:(promise:Promise<unknown>)=>promises.push(promise) });
    await Promise.all(promises);
  };
  return { fire,shown,open,fetch };
}
const id = `web_delivery_${"a".repeat(48)}`;
describe("browser alert receipt boundary",()=>{
  it("refuses arbitrary delivery endpoints including host suffix attacks",()=>{
    expect(isBrowserPushEndpoint("https://fcm.googleapis.com/fcm/send/test")).toBe(true);
    for(const value of ["http://fcm.googleapis.com/x","https://127.0.0.1/x","https://fcm.googleapis.com.evil.test/x","https://user@fcm.googleapis.com/x","https://web.push.apple.com:444/x"]) expect(isBrowserPushEndpoint(value)).toBe(false);
  });
  it("does not display or acknowledge an expired or different account's push",async()=>{
    const app=harness(async()=>new Response(null,{status:403})); await app.fire("push",{version:1,id});
    expect(app.shown).not.toHaveBeenCalled();expect(app.fetch).toHaveBeenCalledTimes(1);
  });
  it("records receipt only after the browser actually displays the notification",async()=>{
    const app=harness(async (_url,options)=>Response.json(options?.method === "POST" ? {} : { display:true,title:"Asael",body:"A booking is available." }));
    await app.fire("push",{version:1,id});expect(app.shown).toHaveBeenCalledOnce();
    expect(app.fetch.mock.calls[1][1]).toMatchObject({method:"POST",body:JSON.stringify({kind:"received"})});
    expect(app.shown.mock.invocationCallOrder[0]).toBeLessThan(app.fetch.mock.invocationCallOrder[1]);
  });
  it("suppresses a duplicate with an existing recorded receipt",async()=>{
    const app=harness(async()=>Response.json({display:false}));await app.fire("push",{version:1,id});expect(app.shown).not.toHaveBeenCalled();
  });
  it("refuses arbitrary notification navigation and still opens the watch workspace",async()=>{
    const app=harness(async()=>Response.json({href:"https://evil.test"}));await app.fire("notificationclick",{id});
    expect(app.open).toHaveBeenCalledWith("https://asael.example/app/watches");
  });
});
