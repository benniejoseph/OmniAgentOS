#!/usr/bin/env node
/** One app-owned engineering attempt on staging, then exact canonical readback. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { exerciseImprovement, pauseProbeConfiguration, readbackImprovement, improvementProbeMethod, probeSha256 } from "./self-improvement/probe.mjs";

const required=name=>{const value=process.env[name];if(!value?.trim())throw new Error(`${name} is required`);return value;};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const production="https://asael.bennierichard.com",base=new URL(required("BASE_URL"));
assert(base.protocol==="https:" && !base.username && !base.password && base.pathname==="/" && !base.search && !base.hash &&
  (base.origin===production || /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(base.origin)),"Unapproved improvement verification origin");
const phase=required("SMOKE_SELF_IMPROVEMENT_MODE"),revision=required("EXPECTED_REVISION"),file=required("SMOKE_SELF_IMPROVEMENT_EVIDENCE_FILE");
assert(["exercise","readback"].includes(phase) && /^[a-f0-9]{40}$/.test(revision),"Invalid improvement verification binding");
assert(phase!=="exercise" || base.origin!==production,"Engineering exercise must occur on staged hosting before promotion");
assert(required("LIVE_VERIFY_SELF_IMPROVEMENT")==="CONFIRMED","One bounded engineering attempt requires admission");
const email=required("SMOKE_PAID_AGENT_EMAIL"),password=required("SMOKE_PAID_AGENT_PASSWORD"),internal=required("SMOKE_INTERNAL_AUTH_SECRET");
const bypass=process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
let cookie="",ownsEvidence=false,failure=null,signedOut=false;
let evidence={scenario:"self_improvement_v1",revision,status:"pending",marker:randomUUID(),maxCostUsd:10,observations:[],resourcesRetained:true};
const safe=value=>{let text=String(value);for(const secret of [email,password,internal,bypass,cookie])if(secret)text=text.replaceAll(secret,"[redacted]");return text.slice(0,700);};

try {
  if(phase==="exercise") {
    const target=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {await target.writeFile(JSON.stringify(evidence,null,2)+"\n");await target.sync();}finally{await target.close();}
    ownsEvidence=true;
  } else {
    const target=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const info=await target.stat();assert(info.isFile() && info.uid===process.getuid() && !(info.mode&0o077) && info.size<100_000,"Private improvement receipt is invalid");evidence=JSON.parse(await target.readFile("utf8"));}finally{await target.close();}
    assert(evidence.scenario==="self_improvement_v1" && evidence.revision===revision && evidence.exerciseStatus==="passed","Improvement receipt belongs to a different or incomplete release");
    ownsEvidence=true;
  }
  const health=await json("/api/health");assert(health.status==="healthy" && health.revision===revision,"Candidate health/revision mismatch");
  const login=await request("/api/auth/login",{email,password},"login");
  cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
  assert(login.status===200 && cookie,"Fresh improvement verification sign-in failed");
  const auth=await body(login);
  assert(auth.authenticated===true && auth.context?.source==="session" && auth.context?.tenantId && auth.context?.actorId,"Improvement verification needs the signed-in owner");
  const ownerHash=probeSha256([auth.context.tenantId,auth.context.actorId,auth.user?.id]);
  if(phase==="readback")assert(evidence.ownerHash===ownerHash,"Improvement receipt owner changed");
  else {evidence.ownerHash=ownerHash;await save();}
  if(phase==="exercise")await exerciseImprovement({json,evidence,save,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
  else await readbackImprovement({json,evidence});
  assert((await json("/api/health")).revision===revision,"Revision changed during improvement verification");
  evidence.status="passed";
  if(phase==="readback")evidence.canonicalReadback=true;
} catch(error) {
  failure=error;evidence.status="failed";
  evidence.failure=safe(error.code==="EEXIST" ? "This engineering attempt already has evidence; reconcile it instead of starting another." : error.message);
} finally {
  if(cookie && ownsEvidence && phase==="exercise") {
    try {await pauseProbeConfiguration({json,evidence,save});}
    catch(error) {failure ||= error;evidence.cleanupFailure=safe(error.message);}
  }
  if(cookie)try {const out=await json("/api/auth/logout",{},"logout");assert(out.authenticated===false,"Improvement sign-out incomplete");signedOut=true;}
  catch(error) {failure ||= error;evidence.signOutFailure=safe(error.message);}
  evidence.signedOut=signedOut;
  if(failure)evidence.status="failed";
  if(phase==="exercise")evidence.exerciseStatus=failure?"failed":"passed";
  if(ownsEvidence)await save();
}
console.log(JSON.stringify({scenario:evidence.scenario,revision,status:failure?"FAIL":"PASS",cycleId:evidence.cycleId,
  stage:evidence.lastCycle?.stage,pullRequestUrl:evidence.proof?.pullRequestUrl,spendUsd:evidence.proof?.spendUsd,
  canonicalReadback:evidence.canonicalReadback,configurationPaused:evidence.configurationPaused || false,
  signedOut,failure:evidence.failure || evidence.cleanupFailure || evidence.signOutFailure || undefined},null,2));
if(failure)process.exitCode=1;

async function save() {
  const target=await open(file,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);
  try {const info=await target.stat();assert(info.isFile() && info.uid===process.getuid() && !(info.mode&0o077),"Private receipt ownership changed");
    await target.writeFile(JSON.stringify(evidence,null,2)+"\n");await target.sync();}finally{await target.close();}
}
async function request(path,value,step,options={}) {
  const method=improvementProbeMethod(path,value,phase);
  return fetch(base.origin+path,{method,headers:{origin:production,"x-omni-synthetic-auth":internal,
    "x-omni-synthetic-source":"self-improvement-release-verification","x-omni-slo-excluded":"true",
    ...(cookie?{cookie}:{}),...(bypass?{"x-vercel-protection-bypass":bypass}:{}),
    ...(method==="POST"?{"content-type":"application/json","idempotency-key":`improvement-smoke:${evidence.marker}:${step}`}:{})},
    body:value===undefined?undefined:JSON.stringify(value),
    signal:AbortSignal.timeout(Math.min(value===undefined?30_000:270_000,options.timeoutMs??270_000)),redirect:"manual",cache:"no-store"});
}
async function json(path,value,step,options) {
  const response=await request(path,value,step,options);
  assert(response.status===200 || (path==="/api/projects" && response.status===201),`${value===undefined?"GET":"POST"} ${path} returned HTTP ${response.status}`);
  return body(response);
}
async function body(response) {
  const reader=response.body?.getReader();assert(reader,"Missing verification response");let length=0;const chunks=[];
  for(;;){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>2_000_000){await reader.cancel();throw new Error("Verification response exceeded its bound");}chunks.push(item.value);}
  return JSON.parse(Buffer.concat(chunks,length).toString("utf8"));
}
