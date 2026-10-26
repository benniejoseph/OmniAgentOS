import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { improvementProbeMethod, verifiedImprovementCycle, exerciseImprovement, pauseProbeConfiguration, readbackImprovement, readbackImprovementQueue, probeSha256 } from "./probe.mjs";

const seal=(kind,value,field)=>({...value,[field]:probeSha256({contract:"asael-self-improvement",version:1,kind,value})});
function fixture() {
  const revision="a".repeat(40), source="b".repeat(40),workspace="c".repeat(64);
  const policy=seal("policy",{dailyBudgetUsd:10,autoReleaseRoutineChanges:true,notifyOutcomes:false},"policySha256");
  const scope={tenantId:"tenant",ownerActorId:"actor",baseRevision:revision,repository:{owner:"benniejoseph",name:"OmniAgentOS",defaultBranch:"main"}};
  const candidate=seal("candidate",{revision:source,workspaceSha256:workspace,changedFiles:[{path:"src/feature.ts"}]},"candidateSha256");
  const checks=["focused_regression","adjacent_regression","typecheck","independent_review"].map(kind=>({kind,outcome:"passed",declaredCases:1,executedCases:1,failedCases:0,candidateRevision:source,workspaceSha256:workspace}));
  const validation=seal("validation",{scope,policySha256:policy.policySha256,candidateSha256:candidate.candidateSha256,workspaceSha256:workspace,candidateRevision:source,
    baselineReproduction:{revision,failedCases:1,executedCases:1},checks},"validationSha256");
  const cycle={id:"cycle",projectId:"project",configurationId:"config",revision:12,stage:"ready_for_release",usageState:"known",spendUsd:0.5,dailyReservationUsd:10,
    executionLeaseExpiresAt:new Date(0).toISOString(),scope,policy,candidate,validation,agentRuns:["atlas","forge","sentinel"].map(agentId=>({agentId,completed:true})),
    pullRequestUrl:"https://github.com/benniejoseph/OmniAgentOS/pull/123",builderSessionId:"session",checkpointId:"checkpoint",verificationId:"verification",deliveryId:"delivery"};
  return {cycle,evidence:{revision,cycleId:"cycle",projectId:"project",configurationId:"config",configurationGeneration:1,policySha256:policy.policySha256}};
}
test("both canonical readbacks have no resource mutation or advance authority",()=>{
  for(const phase of ["readback","queue_readback"]) {
    assert.equal(improvementProbeMethod("/api/self-improvement",undefined,phase),"GET");
    assert.equal(improvementProbeMethod("/api/auth/logout",{},phase),"POST");
    for(const action of ["run","advance","configure","review","pause"])assert.throws(()=>improvementProbeMethod("/api/self-improvement",{action},phase),/cannot mutate/);
  }
  assert.equal(improvementProbeMethod("/api/self-improvement",{action:"advance"},"exercise"),"POST");
  assert.throws(()=>improvementProbeMethod("/api/self-improvement",undefined,"unknown"),/Invalid.*mode/);
});
test("reviewed repair proof requires all three agents and real bound passing cases",()=>{
  const {cycle,evidence}=fixture();assert.equal(verifiedImprovementCycle(cycle,evidence).spendUsd,0.5);
  for(const change of [{usageState:"unknown"},{stage:"no_change"},{spendUsd:10.01},{agentRuns:[{agentId:"atlas",completed:true}]}])
    assert.throws(()=>verifiedImprovementCycle({...cycle,...change},evidence));
  const bad=structuredClone(cycle);bad.validation.checks[0].executedCases=0;
  assert.throws(()=>verifiedImprovementCycle(bad,evidence),/Changed validation/);
  const {validationSha256:_,...body}=bad.validation;bad.validation=seal("validation",body,"validationSha256");
  assert.throws(()=>verifiedImprovementCycle(bad,evidence),/Missing actual passing/);
});
test("a preexisting policy is not replaced and failed trial cleanup pauses only its own project",async()=>{
  await assert.rejects(()=>exerciseImprovement({json:async()=>({github:{configured:true},configurations:[{repositoryId:"1260961340"}]}),evidence:{},save:async()=>{},sleep:async()=>{}}),/will not replace/);
  let paused=false;const actions=[];
  const evidence={projectId:"project",configurationId:"config"};
  await pauseProbeConfiguration({evidence,save:async()=>{},json:async(_,body)=>{
    if(!body)return {configurations:[{id:"foreign",projectId:"other",repositoryId:"1260961340",generation:8,paused:false},
      {id:"config",projectId:"project",repositoryId:"1260961340",generation:1,paused}]};
    actions.push(body);paused=true;return {configuration:{paused}};
  }});
  assert.deepEqual(actions,[{action:"pause",input:{configurationId:"config",expectedGeneration:1,paused:true}}]);assert.equal(evidence.configurationPaused,true);
});

const jobId="11111111-1111-4111-8111-111111111112";
function serviceReceipt(outcome,step,marker,time) {
  const body={schemaVersion:1,receiptKind:"app_service_receipt",boundaryVersion:"p9.1-app-service-boundary:1",operation:"app.self_improvement.advance",
    action:"manage.workflow",resourceType:"self_improvement",eventContract:"self-improvement-events.v1",accessMode:"mutation",authoritySha256:"d".repeat(64),
    idempotencyKeySha256:createHash("sha256").update(`tenant\u0000improvement-smoke:${marker}:${step}`).digest("hex"),outcomeSha256:probeSha256(outcome),
    resourceCount:1,occurredAt:new Date(time).toISOString()};
  return {...outcome,serviceReceipt:{...body,receiptSha256:probeSha256(body)}};
}
function applicationProbe(options={}) {
  const {cycle:ready,evidence:expected}=fixture();
  let current={...ready,revision:1,stage:"observing",phase:"setup"},configured=false,started=false,advanceCount=0;
  let clock=Date.parse("2026-10-26T10:00:00.000Z");
  let job={id:jobId,type:"self_improvement.cycle.tick",status:"queued",attempt:0,maxAttempts:1,result:null,completedAt:null};
  const configuration={id:"config",projectId:"project",repositoryId:"1260961340",generation:1,paused:false,policy:ready.policy};
  const evidence={revision:expected.revision,marker:"trial"},calls=[],saved=[];
  const save=async()=>saved.push(structuredClone(evidence)),sleep=async(ms)=>{clock+=ms;};
  const json=async(path,body,step,requestOptions)=>{
    calls.push({path,body,step,requestOptions});
    if(!body) {
      if(path.startsWith("/api/operations/jobs/")) {assert.equal(path,`/api/operations/jobs/${jobId}`);return {job:options.jobRead?options.jobRead(job,clock):job};}
      return {github:{configured:true},configurations:configured?[configuration]:[],cycles:started?[options.observe?options.observe(current,clock):current]:[]};
    }
    if(path==="/api/projects")return {project:{id:"project"}};
    if(body.action==="configure"){assert.equal(body.input.autoReleaseRoutineChanges,true);assert.equal(body.input.notifyOutcomes,false);configured=true;return {configuration};}
    if(body.action==="run"){started=true;return {outcome:"claimed",cycle:{id:current.id},operationJob:{id:job.id,type:job.type,status:job.status}};}
    if(body.action==="advance") {
      assert.equal(saved.at(-1).advances.at(-1).status,"started","Persist the request before paid execution");
      assert.equal(body.input.cycleId,current.id);assert.equal(body.input.expectedRevision,current.revision);
      assert.equal(step,`advance-${current.revision}`);assert.equal(requestOptions.timeoutMs,270_000);advanceCount++;
      if(options.advanceError)throw new Error(options.advanceError);
      clock+=options.advanceTimeMs || 100;
      current={...current,revision:options.noProgress?current.revision:current.revision+1,
        stage:advanceCount>=(options.phases || 2)?"ready_for_release":"implementing",phase:`phase-${advanceCount}`};
      const outcome={phaseResult:{resourceId:current.id,...(current.stage==="ready_for_release"?{stage:current.stage}:{__deferOperation:true,delaySeconds:2})},cycle:current};
      const response=serviceReceipt(outcome,step,evidence.marker,clock);
      return options.response?options.response(response,step,clock):response;
    }
    throw new Error("The probe must not approve, restart, or tick work");
  };
  return {evidence,calls,saved,json,save,sleep,now:()=>clock,configuration,
    run:()=>exerciseImprovement({json,evidence,save,sleep,now:()=>clock}),
    get cycle(){return current;},set cycle(value){current=value;},get job(){return job;},set job(value){job=value;},
    moveClock:ms=>{clock+=ms;},get advanceCount(){return advanceCount;}};
}
async function completedProbe() {
  const probe=applicationProbe();await probe.run();probe.evidence.exerciseStatus="passed";
  await readbackImprovement(probe);probe.evidence.canonicalReadback=true;probe.moveClock(1000);
  return probe;
}
const completeJob=(probe,changes={})=>({...probe.job,status:"completed",attempt:1,completedAt:new Date(probe.now()).toISOString(),
  result:{resourceId:"cycle",stage:probe.evidence.proof.stage},...changes});
const queueReadback=(probe,activatedAt=new Date(probe.now()).toISOString())=>readbackImprovementQueue({...probe,activatedAt});

test("the compatibility trial rejects even a correctly sealed policy with notifications enabled",()=>{
  const {cycle,evidence}=fixture();
  const {policySha256:_,...body}=cycle.policy;
  cycle.policy=seal("policy",{...body,notifyOutcomes:true},"policySha256");
  evidence.policySha256=cycle.policy.policySha256;
  assert.throws(()=>verifiedImprovementCycle(cycle,evidence),/staged improvement policy changed/);
});

test("staging advances the app handler once per observed revision and retains the pending job",async()=>{
  const probe=applicationProbe();await probe.run();
  assert.deepEqual(probe.calls.filter(item=>item.body).map(item=>item.body.action||"project"),["project","configure","run","advance","advance"]);
  assert.equal(probe.evidence.executionMode,"staged_owner_advance");assert.equal(probe.evidence.dailyAutonomyProven,false);
  assert.deepEqual(probe.evidence.advances.map(item=>[item.expectedRevision,item.resultRevision,item.status]),[[1,2,"completed"],[2,3,"completed"]]);
  assert.equal(probe.evidence.stagedPendingJob.attempt,0);
  await pauseProbeConfiguration({json:async()=>{throw new Error("Successful candidate must stay unchanged")},evidence:probe.evidence,save:async()=>{}});
  probe.evidence.exerciseStatus="passed";const before=probe.calls.length;await readbackImprovement(probe);
  assert.ok(probe.calls.slice(before).every(call=>call.body===undefined));
  await assert.rejects(()=>readbackImprovement({...probe,evidence:{...probe.evidence,executionMode:"normal_background_queue"}}),/owner-advanced/);
  probe.cycle={...probe.cycle,validation:{...probe.cycle.validation,validationSha256:"0".repeat(64)}};
  await assert.rejects(()=>readbackImprovement(probe),/Changed validation/);
});

for(const [label,options,error] of [
  ["uncertain transport",{advanceError:"timeout"},/timeout/],
  ["no revision progress",{noProgress:true},/no durable revision progress/],
  ["wrong result scope",{response:r=>({...r,cycle:{...r.cycle,projectId:"foreign"}})},/changed scope/],
  ["changed receipt",{response:r=>({...r,serviceReceipt:{...r.serviceReceipt,outcomeSha256:"0".repeat(64)}})},/receipt does not bind/],
  ["different request receipt",{response:(r,_step,clock)=>serviceReceipt({cycle:r.cycle,phaseResult:r.phaseResult},"other-request","trial",clock)},/receipt does not bind/],
  ["foreign result cycle",{response:(r,step,clock)=>serviceReceipt({cycle:r.cycle,phaseResult:{resourceId:"other"}},step,"trial",clock)},/different cycle/],
]) test(`${label} stops without replaying an owner advance`,async()=>{
  const probe=applicationProbe(options);await assert.rejects(probe.run,error);
  assert.equal(probe.advanceCount,1);assert.equal(probe.evidence.advances[0].status,"unconfirmed");assert.equal(probe.evidence.proof,undefined);
});

test("one correction fits the 21-phase bound and a 22nd phase is refused",async()=>{
  const good=applicationProbe({phases:21});await good.run();assert.equal(good.advanceCount,21);
  const extra=applicationProbe({phases:22});await assert.rejects(extra.run,/exceeded 21/);assert.equal(extra.advanceCount,21);
});

test("active leases are only observed and paid calls need their full deadline window",async()=>{
  const leased=applicationProbe({observe:(cycle,clock)=>({...cycle,executionLeaseExpiresAt:new Date(clock+60_000).toISOString()})});
  await assert.rejects(leased.run,/within 45 minutes/);assert.equal(leased.advanceCount,0);
  const slow=applicationProbe({advanceTimeMs:42*60_000});await assert.rejects(slow.run,/Insufficient time/);assert.equal(slow.advanceCount,1);
});

test("failed work, unknown usage, and foreign scope cannot be advanced",async()=>{
  for(const [patch,error] of [[{stage:"failed"},/ended at failed/],[{usageState:"unknown"},/usage is unknown/],[{projectId:"foreign"},/changed scope/]]) {
    const probe=applicationProbe({observe:cycle=>({...cycle,...patch})});await assert.rejects(probe.run,error);assert.equal(probe.advanceCount,0);
  }
});

test("an early queue pickup cannot mix manual and background execution",async()=>{
  const probe=applicationProbe({jobRead:job=>({...job,status:"running",attempt:1})});
  await assert.rejects(probe.run,/before canonical activation/);assert.equal(probe.advanceCount,0);
});

test("post-activation completion proves exact no-op dispatch with GET only",async()=>{
  const probe=await completedProbe(),activatedAt=new Date(probe.now()).toISOString();probe.moveClock(1000);
  probe.job=completeJob(probe);const before=probe.calls.length;await queueReadback(probe,activatedAt);
  assert.ok(probe.calls.slice(before).every(item=>item.body===undefined));
  assert.equal(probe.evidence.queueReadback.status,"passed");assert.equal(probe.evidence.queueReadback.mode,"completed_cycle_noop");
  assert.equal(probe.evidence.queueReadback.dailyAutonomyProven,false);assert.equal(probe.evidence.queueReadback.jobId,jobId);
  assert.equal(probe.advanceCount,2);
});

for(const [label,patch] of [
  ["foreign job",{id:"22222222-2222-4222-8222-222222222222"}], ["foreign type",{type:"another.job"}],
  ["foreign cycle",{result:{resourceId:"foreign",stage:"ready_for_release"}}], ["changed stage",{result:{resourceId:"cycle",stage:"succeeded"}}],
  ["early completion",{completedAt:"2026-10-26T09:59:00.000Z"}], ["future completion",{completedAt:"2030-01-01T00:00:00.000Z"}],
  ["repeated attempt",{attempt:2}], ["failed job",{status:"failed"}],
]) test(`queue readback rejects ${label}`,async()=>{
  const probe=await completedProbe();probe.job=completeJob(probe,patch);
  await assert.rejects(()=>queueReadback(probe),/retained improvement job|post-activation no-op dispatch/);
  assert.notEqual(probe.evidence.queueReadback.status,"passed");assert.equal(probe.advanceCount,2);
});

test("queue readback requires prior canonical evidence and actual activation time",async()=>{
  const probe=await completedProbe();
  for(const timestamp of [undefined,"bad","2026-10-26T09:00:00.000Z","2030-01-01T00:00:00.000Z"])
    await assert.rejects(()=>readbackImprovementQueue({...probe,activatedAt:timestamp}),/activation timestamp/);
  probe.evidence.canonicalReadback=false;await assert.rejects(()=>queueReadback(probe),/activation timestamp/);
});

test("queue readback stops after five minutes without advancing or recreating work",async()=>{
  const probe=await completedProbe(),before=probe.calls.length;
  await assert.rejects(()=>queueReadback(probe),/within five minutes/);
  assert.ok(probe.calls.slice(before).every(item=>item.body===undefined));
  assert.equal(probe.evidence.queueReadback.observations.length,20);assert.equal(probe.advanceCount,2);
});

test("queue completion cannot conceal changed candidate proof",async()=>{
  const probe=await completedProbe();probe.job=completeJob(probe);probe.cycle={...probe.cycle,spendUsd:0.6};
  await assert.rejects(()=>queueReadback(probe),/differs from the exact staged repair/);
});
