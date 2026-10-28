import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { improvementAdvanceTimeoutMs, improvementProbeRequestTimeoutMs, improvementEngineeringTokenCap, improvementProbeMethod, improvementProbeError, verifiedImprovementCycle, admitImprovement, exerciseImprovement, pauseProbeConfiguration, readbackImprovement, readbackImprovementQueue, probeSha256 } from "./probe.mjs";
import { readImprovementReceipt, writeImprovementReceipt } from "./probe-receipt.mjs";

const seal=(kind,value,field)=>({...value,[field]:probeSha256({contract:"asael-self-improvement",version:1,kind,value})});
test("the optional release token cap uses a strict bounded decimal environment value",()=>{
  assert.equal(improvementEngineeringTokenCap(undefined),undefined);
  for(const value of ["1","600000","1000000"])assert.equal(improvementEngineeringTokenCap(value),Number(value));
  for(const value of ["","0","-1","1.5","600000 "," 600000","0600000","6e5","1000001",600000,null])
    assert.throws(()=>improvementEngineeringTokenCap(value),/token cap/);
});
test("failed HTTP details remain useful, bounded and free of release credentials",()=>{
  assert.equal(improvementProbeError("Project was not found."),"Project was not found.");
  const detail=improvementProbeError("owner@example.test password-secret cookie-secret postgres://name:unknown@db.invalid Bearer abcdefghijk sk-anotherlongsecretvalue",["owner@example.test","password-secret","cookie-secret"]);
  assert.ok(!/owner@example|password-secret|cookie-secret|name:unknown|abcdefghijk|sk-another/.test(detail));
  assert.match(detail,/postgres:\/\/\[redacted\]@db.invalid/);
  assert.equal(improvementProbeError("x".repeat(800)).length,700);
});
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
    for(const action of ["run","retry","advance","configure","review","pause"])assert.throws(()=>improvementProbeMethod("/api/self-improvement",{action},phase),/cannot mutate/);
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
function serviceReceipt(outcome,step,marker,time,operation="app.self_improvement.advance") {
  const body={schemaVersion:1,receiptKind:"app_service_receipt",boundaryVersion:"p9.1-app-service-boundary:1",operation,
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
      assert.equal(step,`advance-${current.revision}`);assert.equal(requestOptions.timeoutMs,options.advanceTimeoutMs || 270_000);advanceCount++;
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

test("only a bounded static-check hint extends the exact owner request to 285s",async()=>{
  assert.equal(improvementAdvanceTimeoutMs({phase:"inspect"}),270_000);
  assert.equal(improvementAdvanceTimeoutMs({phase:"verify",advanceTimeoutMs:240_000}),270_000);
  for(const phase of ["baseline_check","verify"]) {
    assert.equal(improvementAdvanceTimeoutMs({phase,advanceTimeoutMs:270_000}),285_000);
    const probe=applicationProbe({phases:1,advanceTimeoutMs:285_000});
    probe.cycle={...probe.cycle,phase,advanceTimeoutMs:270_000};
    await probe.run();
    assert.equal(probe.advanceCount,1);
  }
  for(const cycle of [{phase:"inspect",advanceTimeoutMs:270_000},{phase:"verify",advanceTimeoutMs:300_000}]) {
    assert.throws(()=>improvementAdvanceTimeoutMs(cycle),/bounded|static-check/);
  }
});
test("the actual request clamp preserves 285s only for advances and retains shorter request limits",()=>{
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",{action:"advance"},285_000),285_000);
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",{action:"advance"}),270_000);
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",{action:"run"},285_000),270_000);
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",undefined,285_000),30_000);
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",{action:"advance"},300_000),285_000);
  assert.equal(improvementProbeRequestTimeoutMs("/api/self-improvement",{action:"advance"},1_000),1_000);
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

test("two deterministic preparation checks fit the 23-phase bound and a 24th phase is refused",async()=>{
  const good=applicationProbe({phases:23});await good.run();assert.equal(good.advanceCount,23);
  const extra=applicationProbe({phases:24});await assert.rejects(extra.run,/exceeded 23/);assert.equal(extra.advanceCount,23);
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

function retainedAdmission(options={}) {
  const {cycle:original}=fixture(),calls=[];
  const parent={...original,id:"failed-cycle",revision:5,stage:"failed",phase:"setup",spendUsd:0,setupRetryAvailable:true,
    candidate:undefined,validation:undefined,builderSessionId:undefined,agentRuns:[],...options.parent};
  const policy=parent.policy;
  let configuration={id:"config",projectId:"project",repositoryId:"1260961340",generation:2,paused:true,policy,...options.configuration};
  const evidence={revision:"e".repeat(40),ownerHash:"f".repeat(64),marker:"new-trial"};
  const previous={scenario:"self_improvement_v1",revision:original.scope.baseRevision,ownerHash:evidence.ownerHash,
    status:"failed",exerciseStatus:"failed",signedOut:true,maxCostUsd:10,projectId:"project",configurationId:"config",cycleId:"failed-cycle",
    policySha256:policy.policySha256,operationJob:{id:jobId,type:"self_improvement.cycle.tick",status:"queued"},...options.previous};
  const retryEvidence={evidence:previous,sha256:"8".repeat(64)},saved=[];
  const json=async(path,body,step)=>{
    calls.push({path,body,step});
    if(!body) {
      if(path==="/api/projects/project")return {project:{id:"project",status:"active"}};
      if(path===`/api/operations/jobs/${jobId}`)return {job:{...previous.operationJob,attempt:0,maxAttempts:1}};
      return {github:{configured:true},configurations:[configuration],cycles:[parent,...(options.extraCycles || [])]};
    }
    if(body.action==="pause") {
      assert.equal(body.input.configurationId,configuration.id);assert.equal(body.input.expectedGeneration,configuration.generation);
      configuration={...configuration,generation:configuration.generation+1,paused:false};return {configuration};
    }
    assert.equal(body.action,"retry");assert.deepEqual(body.input,{configurationId:"config",expectedGeneration:3,failedCycleId:"failed-cycle",expectedRevision:5});
    if(options.retryError)throw new Error(options.retryError);
    const cycle={...parent,id:"new-cycle",revision:2,stage:"observing",scope:{...parent.scope,baseRevision:evidence.revision}};
    const outcome={outcome:"claimed",cycle,operationJob:{id:"22222222-2222-4222-8222-222222222222",type:"self_improvement.cycle.tick",status:"queued"},
      retryOf:{cycleId:parent.id,revision:parent.revision,cycleSha256:"9".repeat(64),toolExecutionId:"tool-id",toolReceiptSha256:"7".repeat(64)}};
    const response=serviceReceipt(outcome,step,evidence.marker,Date.parse("2026-10-26T13:00:00Z"),"app.self_improvement.retry");
    return options.response?options.response(response):response;
  };
  return {evidence,previous,parent,calls,saved,retryEvidence,json,save:async()=>saved.push(structuredClone(evidence)),
    run:()=>admitImprovement({json,evidence,retryEvidence,save:async()=>saved.push(structuredClone(evidence))})};
}

test("an explicit retry retains the failed cycle and resumes only its exact saved configuration",async()=>{
  const trial=retainedAdmission(),before=structuredClone(trial.previous),parent=structuredClone(trial.parent);
  const started=await trial.run();assert.equal(started.cycle.id,"new-cycle");
  assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),["pause","retry"]);
  assert.deepEqual(trial.previous,before);assert.deepEqual(trial.parent,parent);
  assert.equal(trial.evidence.configurationGeneration,3);assert.equal(trial.evidence.retry.failedCycleRevision,5);
  assert.equal(trial.evidence.retry.admissionReceipt.operation,"app.self_improvement.retry");
  assert.ok(trial.calls.every(call=>call.path!=="/api/projects"));
});
for(const [label,options] of [
  ["foreign owner",{previous:{ownerHash:"other"}}],
  ["retry chain",{previous:{retry:{failedCycleId:"older"}}}],
  ["paid work",{parent:{spendUsd:0.01}}],
  ["unknown usage",{parent:{usageState:"unknown"}}],
  ["existing Builder",{parent:{builderSessionId:"created-session"}}],
  ["unproven no-effect receipt",{parent:{setupRetryAvailable:false}}],
  ["agent work",{parent:{agentRuns:[{agentId:"atlas",completed:false}]}}],
  ["nonterminal parent",{parent:{stage:"observing"}}],
  ["changed policy",{configuration:{policy:{dailyBudgetUsd:100,policySha256:"wrong"}}}],
  ["another active cycle",{extraCycles:[{id:"other",configurationId:"config",stage:"implementing"}]}],
]) test(`retained retry refuses ${label} before mutations`,async()=>{
  const trial=retainedAdmission(options);await assert.rejects(trial.run);assert.equal(trial.calls.filter(call=>call.body).length,0);
});
test("a changed retry receipt or parent lineage cannot be accepted",async()=>{
  for(const response of [value=>({...value,serviceReceipt:{...value.serviceReceipt,outcomeSha256:"0".repeat(64)}}),
    value=>({...value,retryOf:{...value.retryOf,cycleId:"foreign"}})]) {
    const trial=retainedAdmission({response});await assert.rejects(trial.run);assert.equal(trial.evidence.retry.admissionReceipt,undefined);
  }
});
test("an uncertain explicit retry is not automatically repeated",async()=>{
  const trial=retainedAdmission({retryError:"lost response"});await assert.rejects(trial.run,/lost response/);
  assert.equal(trial.calls.filter(call=>call.body?.action==="retry").length,1);
  assert.equal(trial.evidence.retry.failedCycleId,"failed-cycle");assert.equal(trial.evidence.retry.admissionReceipt,undefined);
});

test("canonical readback revalidates the exact retry admission and failed lineage",async()=>{
  const probe=await completedProbe();
  const parent={...probe.cycle,id:"failed-cycle",revision:5,stage:"failed",spendUsd:0,scope:{...probe.cycle.scope,baseRevision:"e".repeat(40)}};
  const outcome={outcome:"claimed",cycle:{...probe.cycle,revision:2,stage:"observing",spendUsd:0},
    operationJob:probe.evidence.operationJob,retryOf:{cycleId:parent.id,revision:5,cycleSha256:"9".repeat(64),toolExecutionId:"tool-id",toolReceiptSha256:"7".repeat(64)}};
  const admitted=serviceReceipt(outcome,"retry-setup",probe.evidence.marker,probe.now(),"app.self_improvement.retry");
  probe.evidence.retry={previousEvidenceSha256:"8".repeat(64),failedCycleId:parent.id,failedCycleRevision:5,
    previousBaseRevision:parent.scope.baseRevision,admissionResponse:admitted,admissionReceipt:admitted.serviceReceipt,lineage:admitted.retryOf};
  const json=async(...args)=>{
    const value=await probe.json(...args);
    return args[0]==="/api/self-improvement" && !args[1]?{...value,cycles:[...value.cycles,parent]}:value;
  };
  await readbackImprovement({...probe,json});
  for(const change of [retry=>{delete retry.admissionResponse;},retry=>{delete retry.admissionReceipt;},
    retry=>{retry.lineage={...retry.lineage,toolExecutionId:"foreign"};},
    retry=>{retry.admissionResponse.cycle.id="foreign";},retry=>{retry.admissionResponse.cycle.projectId="foreign";},
    retry=>{retry.admissionResponse.serviceReceipt.outcomeSha256="0".repeat(64);},
    retry=>{retry.admissionResponse.retryOf.toolReceiptSha256="0".repeat(64);}]) {
    const evidence=structuredClone(probe.evidence);change(evidence.retry);
    await assert.rejects(()=>readbackImprovement({...probe,json,evidence}));
  }
});

function boundedRetainedTrial(options={}) {
  const {cycle:original}=fixture(),calls=[],saved=[];
  const parent={...original,id:"observed-cycle",revision:19,stage:"no_change",phase:"done",spendUsd:0.03548,
    candidate:null,validation:null,release:null,releaseReceipt:null,controllerHold:null,pullRequestUrl:null,
    builderSessionId:"retained-session",summary:"No candidate selected",agentRuns:[{agentId:"atlas",completed:true}],...options.parent};
  let configuration={id:"config",projectId:"project",repositoryId:"1260961340",repository:parent.scope.repository,
    generation:4,paused:true,policy:parent.policy,timeZone:"Asia/Kolkata",dailyHour:3,nextDueAt:"2026-10-26T21:30:00.000Z",...options.configuration};
  const previous={scenario:"self_improvement_v1",revision:original.scope.baseRevision,ownerHash:"f".repeat(64),
    status:"failed",exerciseStatus:"failed",signedOut:true,maxCostUsd:10,projectId:"project",configurationId:"config",cycleId:parent.id,
    policySha256:parent.policy.policySha256,operationJob:{id:jobId,type:"self_improvement.cycle.tick",status:"queued"},
    retry:{failedCycleId:"first-failed-cycle"},lastCycle:{id:parent.id,revision:19,stage:"no_change",spendUsd:0.03548},...options.previous};
  const evidence={revision:"e".repeat(40),ownerHash:"f".repeat(64),marker:"bounded-trial"};
  const retainedEvidence={evidence:previous,sha256:"8".repeat(64)};
  let admitted;
  const json=async(path,body,step)=>{
    calls.push({path,body,step});
    if(!body) {
      if(path==="/api/projects/project")return {project:options.project || {id:"project",status:"active",objective:"Inspect the observed source defect"}};
      if(path===`/api/operations/jobs/${jobId}`)return {job:options.jobRead ? options.jobRead() : {...previous.operationJob,attempt:0,maxAttempts:1}};
      return {github:{configured:true},configurations:[configuration],cycles:[parent,...(admitted?[admitted]:[]),...(options.extraCycles || [])]};
    }
    assert.equal(saved.at(-1).continuation.mutations.at(-1).status,"started");
    if(options.failAction===body.action)throw new Error("response lost");
    let outcome;
    if(body.action==="configure") {
      assert.equal(body.input.expectedGeneration,configuration.generation);
      assert.equal(body.input.dailyBudgetUsd,100);assert.equal(body.input.maxCycleBudgetUsd,10);
      const {policySha256:_old,maxEngineeringTokensPerRun:_oldCap,...policy}=configuration.policy;
      const cap=options.configureTokenCap ? options.configureTokenCap(body.input.maxEngineeringTokensPerRun) : body.input.maxEngineeringTokensPerRun;
      configuration={...configuration,generation:configuration.generation+1,
        policy:seal("policy",{...policy,dailyBudgetUsd:100,maxCycleBudgetUsd:10,...(cap!==undefined?{maxEngineeringTokensPerRun:cap}:{})},"policySha256")};
      outcome={configuration};
    } else if(body.action==="pause") {
      assert.equal(body.input.expectedGeneration,configuration.generation);
      configuration={...configuration,generation:configuration.generation+1,paused:false};outcome={configuration};
    } else {
      assert.equal(body.action,"run");assert.equal(body.input.expectedGeneration,configuration.generation);
      admitted={...parent,id:"new-cycle",revision:1,stage:"observing",phase:"setup",spendUsd:0,
        scope:{...parent.scope,baseRevision:evidence.revision},policy:configuration.policy};
      outcome={outcome:"claimed",cycle:admitted,operationJob:{id:"22222222-2222-4222-8222-222222222222",type:"self_improvement.cycle.tick",status:"queued"}};
    }
    const response=serviceReceipt(outcome,step,evidence.marker,Date.parse("2026-10-26T13:00:00Z"),`app.self_improvement.${body.action}`);
    return options.response?options.response(response,body.action):response;
  };
  return {evidence,previous,parent,calls,saved,json,retainedEvidence,save:async()=>saved.push(structuredClone(evidence)),
    run:()=>admitImprovement({json,evidence,retainedEvidence,maxEngineeringTokensPerRun:options.maxEngineeringTokensPerRun,save:async()=>saved.push(structuredClone(evidence))}),
    get configuration(){return configuration;}};
}
test("bounded owner run retains a paid terminal trial and partitions the authorized daily allowance",async()=>{
  const trial=boundedRetainedTrial(),old=structuredClone(trial.parent),previous=structuredClone(trial.previous);
  const result=await trial.run();assert.equal(result.cycle.dailyReservationUsd,10);assert.equal(result.cycle.policy.dailyBudgetUsd,100);
  assert.deepEqual(trial.calls.filter(x=>x.body).map(x=>x.body.action),["configure","pause","run"]);
  assert.deepEqual(trial.parent,old);assert.deepEqual(trial.previous,previous);
  assert.equal(trial.configuration.generation,6);assert.equal(trial.configuration.nextDueAt,"2026-10-26T21:30:00.000Z");
  assert.equal(trial.evidence.dailyBudgetUsd,100);assert.ok(trial.evidence.continuation.mutations.every(x=>x.status==="completed"));
  assert.equal(trial.calls.filter(x=>x.path==="/api/projects").length,0);
});
test("bounded admission seals an explicit token cap and preserves a prior owner cap when omitted",async()=>{
  for(const explicit of [undefined,600000]) {
    const original=fixture().cycle.policy,{policySha256:_,...body}=original;
    const policy=seal("policy",{...body,maxEngineeringTokensPerRun:400000},"policySha256");
    const trial=boundedRetainedTrial({parent:{policy},maxEngineeringTokensPerRun:explicit});
    const started=await trial.run(),expected=explicit??400000;
    assert.equal(trial.calls.find(call=>call.body?.action==="configure").body.input.maxEngineeringTokensPerRun,expected);
    assert.equal(started.cycle.policy.maxEngineeringTokensPerRun,expected);
    assert.equal(trial.evidence.maxEngineeringTokensPerRun,expected);
    assert.equal(trial.parent.policy.maxEngineeringTokensPerRun,400000);
  }
});
test("a correctly sealed response cannot drop or raise the explicitly admitted token cap",async()=>{
  for(const changed of [undefined,600001]) {
    const trial=boundedRetainedTrial({maxEngineeringTokensPerRun:600000,configureTokenCap:()=>changed});
    await assert.rejects(trial.run,/policy|token cap/);
    assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),["configure"]);
  }
});
test("invalid direct cap admission is refused before reads or mutations",async()=>{
  for(const value of [0,-1,1.5,1000001,"600000",null]) {
    const trial=boundedRetainedTrial({maxEngineeringTokensPerRun:value});
    await assert.rejects(trial.run,/token cap/);assert.equal(trial.calls.length,0);
  }
});
for(const [label,options] of [
  ["foreign owner",{previous:{ownerHash:"other"}}],
  ["unknown usage",{parent:{usageState:"unknown"}}],
  ["unreconciled stage",{parent:{stage:"failed"}}],
  ["changed revision",{parent:{revision:20}}],
  ["changed actual cost",{parent:{spendUsd:0.04}}],
  ["candidate exists",{parent:{candidate:{revision:"c".repeat(40)}}}],
  ["active cycle exists",{extraCycles:[{id:"active",stage:"implementing"}]}],
  ["changed cadence",{configuration:{dailyHour:7}}],
]) test(`bounded retained admission refuses ${label} before mutations`,async()=>{
  const trial=boundedRetainedTrial(options);await assert.rejects(trial.run);assert.equal(trial.calls.filter(x=>x.body).length,0);
});
for(const action of ["configure","pause","run"])test(`uncertain bounded ${action} is retained without replay`,async()=>{
  const trial=boundedRetainedTrial({failAction:action});await assert.rejects(trial.run,/response lost/);
  assert.equal(trial.calls.filter(x=>x.body?.action===action).length,1);
  assert.equal(trial.evidence.continuation.mutations.at(-1).status,"unconfirmed");
});
test("changed bounded admission response cannot prove a fresh run",async()=>{
  const trial=boundedRetainedTrial({response:(value,action)=>action==="run"?{...value,cycle:{...value.cycle,dailyReservationUsd:100}}:value});
  await assert.rejects(trial.run,/mutation receipt/);
});
test("a daily100 policy cannot hide a per-cycle100 cap in the ten-dollar trial",()=>{
  const {cycle,evidence}=fixture();const {policySha256:_,...body}=cycle.policy;
  cycle.policy=seal("policy",{...body,dailyBudgetUsd:100,maxCycleBudgetUsd:100},"policySha256");
  evidence.dailyBudgetUsd=100;evidence.policySha256=cycle.policy.policySha256;
  assert.throws(()=>verifiedImprovementCycle(cycle,evidence),/staged improvement policy changed/);
});

for(const cap of [undefined,600000])for(const paused of [true,false])test(`canonical bounded readback binds retained paid work (${paused ? "resumed" : "already active"}, token cap ${cap})`,async()=>{
  const trial=boundedRetainedTrial({configuration:{paused},maxEngineeringTokensPerRun:cap}),started=await trial.run(),base=fixture().cycle;
  const candidate=base.candidate,scope=started.cycle.scope,policy=started.cycle.policy;
  const {validationSha256:_old,...validationBody}=base.validation;
  const validation=seal("validation",{...validationBody,scope,policySha256:policy.policySha256,
    baselineReproduction:{...validationBody.baselineReproduction,revision:scope.baseRevision}},"validationSha256");
  const ready={...base,id:started.cycle.id,revision:2,scope,policy,candidate,validation};
  const evidence=trial.evidence;
  Object.assign(evidence,{cycleId:ready.id,operationJob:started.operationJob,exerciseStatus:"passed",executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,observations:[{revision:ready.revision}],advances:[]});
  const advanced=serviceReceipt({cycle:ready,phaseResult:{resourceId:ready.id}},"advance-1",evidence.marker,Date.now());
  evidence.advances=[{status:"completed",expectedRevision:1,resultRevision:2,serviceReceipt:advanced.serviceReceipt}];
  evidence.proof=verifiedImprovementCycle(ready,evidence);
  let parent=trial.parent;
  const json=async(path)=>path.startsWith("/api/operations/jobs/")
    ? {job:{...started.operationJob,attempt:0,maxAttempts:1}}
    : {configurations:[trial.configuration],cycles:[parent,ready]};
  await readbackImprovement({json,evidence,save:async()=>{}});
  assert.equal(evidence.maxEngineeringTokensPerRun,cap);
  assert.equal(ready.policy.maxEngineeringTokensPerRun,cap);
  const changedConfiguration={...trial.configuration,policy:{...trial.configuration.policy,maxEngineeringTokensPerRun:cap===undefined?600000:600001}};
  await assert.rejects(()=>readbackImprovement({evidence,json:async(...args)=>{
    const value=await json(...args);return args[0]==="/api/self-improvement"?{...value,configurations:[changedConfiguration]}:value;
  }}),/policy|token cap/);
  for(const tamper of [
    value=>{value.continuation.previousCycleSha256="0".repeat(64);},
    value=>{value.continuation.mutations[0].response.configuration.policy.dailyBudgetUsd=99;},
    value=>{value.continuation.mutations.at(-1).response.operationJob.id="wrong";},
    value=>{value.continuation.mutations[1].status="unconfirmed";},
    value=>{value.continuation.mutations.at(-1).serviceReceipt.outcomeSha256="0".repeat(64);},
  ]) {
    const changed=structuredClone(evidence);tamper(changed);
    await assert.rejects(()=>readbackImprovement({json,evidence:changed,save:async()=>{}}));
  }
  parent={...parent,spendUsd:0.04};
  await assert.rejects(()=>readbackImprovement({json,evidence,save:async()=>{}}),/terminal cycle changed/);
});

function normalFailedTrial(paused=false) {
  const {policySha256:_,...basePolicy}=fixture().cycle.policy;
  const policy=seal("policy",{...basePolicy,dailyBudgetUsd:100,maxCycleBudgetUsd:10},"policySha256");
  const createdAt="2026-10-28T00:21:13.249Z",updatedAt="2026-10-28T00:25:33.314Z";
  const job={id:jobId,type:"self_improvement.cycle.tick",status:"failed",attempt:1,maxAttempts:1,
    createdAt:"2026-10-28T00:21:13.396Z",runAt:"2026-10-28T00:23:08.126Z",
    updatedAt:"2026-10-28T00:25:33.382Z",completedAt:"2026-10-28T00:25:33.382Z",lastError:"Synthetic terminal failure",result:null};
  const project={id:"project",status:"active",objective:"Use valid graph fixtures, exact boundaries and unchanged history."};
  const trial=boundedRetainedTrial({parent:{stage:"failed",phase:"inspect",spendUsd:0.119771,createdAt,updatedAt,policy,
    agentRuns:[{phase:"inspect",agentId:"atlas",runId:"33333333-3333-4333-8333-333333333333",costCeilingUsd:1,completed:true}]},
    configuration:{tenantId:"tenant",ownerActorId:"actor",paused},project,jobRead:()=>job});
  for(const key of ["scenario","exerciseStatus","status","retry"])delete trial.previous[key];
  Object.assign(trial.previous,{artifactKind:"owner_normal_cycle_failure",dailyBudgetUsd:100,
    operationJob:{id:jobId,type:job.type,status:"failed"},lastCycle:{id:trial.parent.id,revision:19,stage:"failed",spendUsd:0.119771}});
  const admitted={...structuredClone(trial.parent),revision:1,stage:"observing",phase:"setup",spendUsd:0,updatedAt:createdAt,agentRuns:[]};
  const admissionResponse=serviceReceipt({outcome:"claimed",cycle:admitted,operationJob:{id:jobId,type:job.type,status:"queued"}},
    "run","saved-owner-request",Date.parse("2026-10-28T00:21:13.460Z"),"app.self_improvement.run");
  trial.previous.normalQueueFailure={tenantId:"tenant",ownerActorId:"actor",admissionResponse,
    admissionIdempotencyKeySha256:admissionResponse.serviceReceipt.idempotencyKeySha256,
    projectObjectiveSha256:probeSha256(project.objective),
    settledUsage:{state:"known",spendUsd:0.119771,unsettledPaidUsage:false,completedRunIds:trial.parent.agentRuns.map(run=>run.runId)},
    terminalJob:{...Object.fromEntries(["id","type","status","attempt","maxAttempts","createdAt","runAt","updatedAt","completedAt"].map(key=>[key,job[key]])),
      quarantined:false,hasError:true}};
  return {...trial,job,project,get configuration(){return trial.configuration;}};
}
for(const paused of [true,false])test(`normal failed owner queue retains actual failure and starts one fresh cycle (${paused ? "paused" : "active"})`,async()=>{
  const trial=normalFailedTrial(paused),before=structuredClone({parent:trial.parent,job:trial.job,previous:trial.previous});
  const result=await trial.run();
  assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),paused?["configure","pause","run"]:["configure","run"]);
  assert.notEqual(result.cycle.id,trial.parent.id);assert.equal(result.operationJob.status,"queued");
  assert.equal(trial.evidence.continuation.retainedJob.status,"failed");
  assert.equal(trial.evidence.continuation.normalQueueFailure.artifactKind,"owner_normal_cycle_failure");
  assert.equal("exerciseStatus" in trial.evidence.continuation.normalQueueFailure,false);
  assert.deepEqual({parent:trial.parent,job:trial.job,previous:trial.previous},before);
});
for(const [label,change] of [
  ["foreign owner",trial=>{trial.previous.ownerHash="0".repeat(64);}],
  ["foreign configuration owner",trial=>{trial.configuration.ownerActorId="foreign";}],
  ["unknown usage",trial=>{trial.parent.usageState="unknown";}],
  ["unsettled phase",trial=>{trial.previous.normalQueueFailure.settledUsage.unsettledPaidUsage=true;}],
  ["incomplete run",trial=>{trial.parent.agentRuns[0].completed=false;}],
  ["changed owner request",trial=>{trial.previous.normalQueueFailure.admissionIdempotencyKeySha256="0".repeat(64);}],
  ["changed admission seal",trial=>{trial.previous.normalQueueFailure.admissionResponse.serviceReceipt.outcomeSha256="0".repeat(64);}],
  ["changed objective",trial=>{trial.project.objective="Different acceptance";}],
  ["queued parent",trial=>{trial.job.status="queued";trial.job.attempt=0;}],
  ["second attempt",trial=>{trial.job.attempt=2;}],
  ["larger attempt allowance",trial=>{trial.job.maxAttempts=2;}],
  ["quarantined job",trial=>{trial.job.quarantined=true;}],
  ["missing completion",trial=>{trial.job.completedAt=null;}],
  ["completion before terminal cycle",trial=>{trial.job.completedAt="2026-10-28T00:23:00.000Z";}],
  ["foreign result cycle",trial=>{trial.job.result={resourceId:"foreign"};}],
  ["invented staged failure",trial=>{trial.previous.exerciseStatus="failed";}],
])test(`normal queue continuation refuses ${label} before mutations`,async()=>{
  const trial=normalFailedTrial();change(trial);await assert.rejects(trial.run);
  assert.equal(trial.calls.filter(call=>call.body).length,0);
});
for(const [label,change] of [
  ["cycle",value=>{value.cycle.id="foreign";}],
  ["configuration",value=>{value.cycle.configurationId="foreign";}],
  ["job",value=>{value.operationJob.id="22222222-2222-4222-8222-222222222222";}],
])test(`normal queue continuation refuses a correctly sealed foreign admission ${label}`,async()=>{
  const trial=normalFailedTrial(),admission=trial.previous.normalQueueFailure.admissionResponse;
  change(admission);
  const {serviceReceipt:old,...outcome}=admission,{receiptSha256:_,...body}=old;
  const next={...body,outcomeSha256:probeSha256(outcome)};
  admission.serviceReceipt={...next,receiptSha256:probeSha256(next)};
  await assert.rejects(trial.run,/exact cycle and original job/);assert.equal(trial.calls.filter(call=>call.body).length,0);
});
test("normal continuation readback retains the failed parent and still requires the new untouched queue",async()=>{
  const trial=normalFailedTrial(),started=await trial.run(),base=fixture().cycle;
  const {validationSha256:_,...validationBody}=base.validation;
  const ready={...base,id:started.cycle.id,scope:started.cycle.scope,policy:started.cycle.policy,
    validation:seal("validation",{...validationBody,scope:started.cycle.scope,policySha256:started.cycle.policy.policySha256,
      baselineReproduction:{...validationBody.baselineReproduction,revision:started.cycle.scope.baseRevision}},"validationSha256")};
  const evidence=trial.evidence;
  Object.assign(evidence,{cycleId:ready.id,operationJob:started.operationJob,exerciseStatus:"passed",executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,observations:[{revision:ready.revision}],advances:[]});
  const advanced=serviceReceipt({cycle:ready,phaseResult:{resourceId:ready.id}},"advance-1",evidence.marker,Date.now());
  evidence.advances=[{status:"completed",expectedRevision:1,resultRevision:ready.revision,serviceReceipt:advanced.serviceReceipt}];
  evidence.proof=verifiedImprovementCycle(ready,evidence);
  const newJob={...started.operationJob,attempt:0,maxAttempts:1};
  const json=async path=>path===`/api/operations/jobs/${jobId}`?{job:trial.job}:
    path.startsWith("/api/operations/jobs/")?{job:newJob}:{configurations:[trial.configuration],cycles:[trial.parent,ready]};
  await readbackImprovement({json,evidence,save:async()=>{}});
  newJob.status="failed";newJob.attempt=1;
  await assert.rejects(()=>readbackImprovement({json,evidence,save:async()=>{}}),/ran before canonical activation/);
  newJob.status="queued";newJob.attempt=0;trial.job.status="queued";
  await assert.rejects(()=>readbackImprovement({json,evidence,save:async()=>{}}),/exact completed failure/);
});

function completedStagedTrial() {
  // Synthetic owner/IDs with the captured766 lifecycle, amount and timestamps.
  // These fixtures are not production receipts. Completion erased startedAt;
  // runAt is queue eligibility, not evidence of execution start.
  const createdAt="2026-10-28T01:01:46.056Z",updatedAt="2026-10-28T01:10:40.949Z";
  const job={id:jobId,type:"self_improvement.cycle.tick",status:"completed",attempt:1,maxAttempts:1,
    createdAt:"2026-10-28T01:01:46.240Z",runAt:"2026-10-28T01:01:46.240Z",
    completedAt:"2026-10-28T01:11:45.168Z",updatedAt:"2026-10-28T01:11:45.168Z",
    progress:{stage:"completed",completedAt:"2026-10-28T01:11:45.143Z"},result:{stage:"failed",resourceId:"observed-cycle"}};
  const {policySha256:_,...basePolicy}=fixture().cycle.policy;
  const policy=seal("policy",{...basePolicy,dailyBudgetUsd:100,maxCycleBudgetUsd:10},"policySha256");
  const agentRuns=["inspect","reproduce","implement","implement"].map((phase,index)=>({phase,
    agentId:index===0?"atlas":"forge",runId:`33333333-3333-4333-8333-33333333333${index}`,completed:true}));
  const project={id:"project",status:"active",objective:"Retain the valid graph acceptance and exact boundary cases."};
  const trial=boundedRetainedTrial({parent:{revision:55,stage:"failed",phase:"implement",spendUsd:0.448569,
    createdAt,updatedAt,agentRuns,policy},configuration:{tenantId:"tenant",ownerActorId:"actor",generation:32},project,jobRead:()=>job});
  delete trial.previous.retry;
  Object.assign(trial.previous,{dailyBudgetUsd:100,executionMode:"staged_owner_advance",dailyAutonomyProven:false,
    configurationPaused:true,stagedPendingJob:{id:jobId,type:job.type,status:"queued",attempt:0,maxAttempts:1},
    lastCycle:{id:trial.parent.id,revision:55,stage:"failed",spendUsd:0.448569},
    continuation:{previousEvidenceSha256:"8".repeat(64),previousCycleId:"normal-failed-origin",
      normalQueueFailure:{artifactKind:"owner_normal_cycle_failure",derivation:{originalEvidenceSha256:"7".repeat(64)}}},
    stagedTerminalNoop:{tenantId:"tenant",ownerActorId:"actor",originalEvidenceSha256:"6".repeat(64),
      projectObjectiveSha256:probeSha256(project.objective),
      settledUsage:{state:"known",spendUsd:0.448569,unsettledPaidUsage:false,completedRunIds:agentRuns.map(run=>run.runId)},
      terminalJob:{...structuredClone(job),quarantined:false,hasError:false}}});
  return {...trial,job,project,get configuration(){return trial.configuration;}};
}
test("a completed staged terminal outcome retains paid failure and its normal-cycle ancestry",async()=>{
  const trial=completedStagedTrial(),before=structuredClone({parent:trial.parent,job:trial.job,previous:trial.previous});
  const result=await trial.run();
  assert.notEqual(result.cycle.id,trial.parent.id);
  assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),["configure","pause","run"]);
  assert.deepEqual(trial.evidence.continuation.stagedTerminalNoop,trial.previous);
  assert.equal(trial.evidence.continuation.stagedTerminalNoopSha256,probeSha256(trial.previous));
  assert.equal(trial.evidence.continuation.retainedJob.status,"completed");
  assert.equal(trial.evidence.continuation.normalQueueFailure,undefined);
  assert.equal(trial.previous.artifactKind,undefined);
  assert.equal(trial.job.progress.startedAt,undefined);
  assert.ok(Date.parse(trial.job.runAt)<Date.parse(trial.parent.updatedAt),"Eligibility is not treated as execution start");
  assert.deepEqual({parent:trial.parent,job:trial.job,previous:trial.previous},before);
});
for(const [label,change] of [
  ["missing origin hash",trial=>{delete trial.previous.stagedTerminalNoop.originalEvidenceSha256;}],
  ["missing objective hash",trial=>{delete trial.previous.stagedTerminalNoop.projectObjectiveSha256;}],
  ["changed objective",trial=>{trial.project.objective="Drop the valid graph acceptance cases";}],
  ["foreign configuration owner",trial=>{trial.configuration.ownerActorId="foreign";}],
  ["foreign proof tenant",trial=>{trial.previous.stagedTerminalNoop.tenantId="foreign";}],
  ["invented normal failure",trial=>{trial.previous.artifactKind="owner_normal_cycle_failure";}],
  ["non-staged execution",trial=>{trial.previous.executionMode="normal_background_queue";}],
  ["prior queue already consumed",trial=>{trial.previous.stagedPendingJob.attempt=1;}],
  ["changed admitted job",trial=>{trial.previous.stagedPendingJob.id="22222222-2222-4222-8222-222222222222";}],
  ["unsettled phase",trial=>{trial.previous.stagedTerminalNoop.settledUsage.unsettledPaidUsage=true;}],
  ["changed settled cost",trial=>{trial.previous.stagedTerminalNoop.settledUsage.spendUsd=0.323551;}],
  ["missing paid run",trial=>{trial.previous.stagedTerminalNoop.settledUsage.completedRunIds.pop();}],
  ["incomplete paid run",trial=>{trial.parent.agentRuns[3].completed=false;}],
  ["unknown usage",trial=>{trial.parent.usageState="unknown";}],
  ["still correcting",trial=>{trial.parent.stage="correcting";}],
  ["stale last observation",trial=>{trial.previous.lastCycle.revision=47;}],
  ["still queued",trial=>{trial.job.status="queued";trial.job.attempt=0;}],
  ["second attempt",trial=>{trial.job.attempt=2;}],
  ["expanded retries",trial=>{trial.job.maxAttempts=2;}],
  ["quarantine",trial=>{trial.job.quarantined=true;}],
  ["error",trial=>{trial.job.lastError="retained failure";}],
  ["foreign result",trial=>{trial.job.result.resourceId="foreign";}],
  ["successful result",trial=>{trial.job.result.stage="succeeded";}],
  ["extra paid result",trial=>{trial.job.result.spendUsd=1;}],
  ["deferred result",trial=>{trial.job.result.__deferOperation=true;}],
  ["completion before terminal",trial=>{trial.job.progress.completedAt="2026-10-28T01:10:00.000Z";}],
  ["job created before cycle",trial=>{trial.job.createdAt="2026-10-28T01:00:00.000Z";}],
  ["missing completion",trial=>{delete trial.job.completedAt;}],
  ["changed saved completion",trial=>{trial.previous.stagedTerminalNoop.terminalJob.completedAt="2026-10-28T01:12:00.000Z";}],
])test(`staged completed continuation refuses ${label} before mutations`,async()=>{
  const trial=completedStagedTrial();change(trial);await assert.rejects(trial.run);
  assert.equal(trial.calls.filter(call=>call.body).length,0);
});
test("staged terminal readback rechecks the old completed job and the new untouched queue",async()=>{
  const trial=completedStagedTrial(),started=await trial.run(),base=fixture().cycle;
  const {validationSha256:_,...validationBody}=base.validation;
  const ready={...base,id:started.cycle.id,scope:started.cycle.scope,policy:started.cycle.policy,
    validation:seal("validation",{...validationBody,scope:started.cycle.scope,policySha256:started.cycle.policy.policySha256,
      baselineReproduction:{...validationBody.baselineReproduction,revision:started.cycle.scope.baseRevision}},"validationSha256")};
  const evidence=trial.evidence;
  Object.assign(evidence,{cycleId:ready.id,operationJob:started.operationJob,exerciseStatus:"passed",executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,observations:[{revision:ready.revision}],advances:[]});
  const advanced=serviceReceipt({cycle:ready,phaseResult:{resourceId:ready.id}},"advance-1",evidence.marker,Date.now());
  evidence.advances=[{status:"completed",expectedRevision:1,resultRevision:ready.revision,serviceReceipt:advanced.serviceReceipt}];
  evidence.proof=verifiedImprovementCycle(ready,evidence);
  const newJob={...started.operationJob,attempt:0,maxAttempts:1};
  const json=async path=>path===`/api/operations/jobs/${jobId}`?{job:trial.job}:
    path.startsWith("/api/operations/jobs/")?{job:newJob}:path==="/api/projects/project"?{project:trial.project}:
      {configurations:[trial.configuration],cycles:[trial.parent,ready]};
  await readbackImprovement({json,evidence,save:async()=>{}});
  const changed=structuredClone(evidence);changed.continuation.stagedTerminalNoop.continuation.previousCycleId="foreign";
  await assert.rejects(()=>readbackImprovement({json,evidence:changed}),/ancestry changed/);
  const objective=trial.project.objective;trial.project.objective="Drop the valid graph acceptance cases";
  await assert.rejects(()=>readbackImprovement({json,evidence}),/acceptance brief changed after staging/);
  trial.project.objective=objective;
  newJob.status="completed";newJob.attempt=1;
  await assert.rejects(()=>readbackImprovement({json,evidence}),/ran before canonical activation/);
  newJob.status="queued";newJob.attempt=0;trial.job.result.stage="ready_for_release";
  await assert.rejects(()=>readbackImprovement({json,evidence}),/exact completed terminal no-op/);
});

function failedStagedTrial() {
  // Synthetic owner/IDs; the actual fc1c/6bcc chronology and public error
  // shape are retained. The job failed after rollback, not a completed no-op.
  const createdAt="2026-10-28T08:33:49.451Z",updatedAt="2026-10-28T08:55:20.455Z";
  const job={id:jobId,type:"self_improvement.cycle.tick",status:"failed",attempt:1,maxAttempts:1,
    createdAt:"2026-10-28T08:33:49.635Z",runAt:"2026-10-28T08:33:49.635Z",
    completedAt:"2026-10-28T08:56:03.078Z",updatedAt:"2026-10-28T08:56:03.078Z",
    progress:{stage:"processing",startedAt:"2026-10-28T08:56:03.001Z"},
    lastError:JSON.stringify([
      {code:"unrecognized_keys",keys:["maxEngineeringTokensPerRun"],path:["policy"],message:'Unrecognized key: "maxEngineeringTokensPerRun"'},
      {code:"custom",path:["policy","policySha256"],message:"Self-improvement policy fingerprint does not match."},
    ],null,2)};
  const {policySha256:_,...body}=fixture().cycle.policy;
  const policy=seal("policy",{...body,dailyBudgetUsd:100,maxCycleBudgetUsd:10,maxEngineeringTokensPerRun:600000},"policySha256");
  const phases=["inspect","reproduce","reproduce","implement","review"],costs=[.121156,.299154,.031343,.041103,.086226];
  const agentRuns=phases.map((phase,index)=>({phase,agentId:index===0?"atlas":index===4?"sentinel":"forge",
    runId:`33333333-3333-4333-8333-33333333333${index}`,costCeilingUsd:index===0||index===4?1:2,completed:true}));
  const project={id:"project",status:"active",objective:"Retain the valid graph acceptance and exact boundary cases."};
  const trial=boundedRetainedTrial({parent:{revision:91,stage:"failed",phase:"review",spendUsd:.578982,
    createdAt,updatedAt,agentRuns,policy},configuration:{tenantId:"tenant",ownerActorId:"actor",generation:44},project,jobRead:()=>job});
  delete trial.previous.retry;
  const initial={...structuredClone(trial.parent),revision:1,stage:"observing",spendUsd:0,agentRuns:[]};
  const originalAdmission=serviceReceipt({outcome:"claimed",cycle:initial,operationJob:trial.previous.operationJob},
    "run-bounded-trial","old-stage",Date.parse("2026-10-28T08:33:49.800Z"),"app.self_improvement.run");
  const failureAttribution={version:1,kind:"previous_policy_reader_rejected",policyField:"maxEngineeringTokensPerRun"};
  const capture=(name,value)=>{const raw=JSON.stringify({httpStatus:200,data:{[name]:value}},null,2)+"\n";
    return {raw,sha256:createHash("sha256").update(raw).digest("hex")};};
  Object.assign(trial.previous,{marker:"old-stage",configurationGeneration:44,dailyBudgetUsd:100,executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,configurationPaused:true,stagedPendingJob:{...trial.previous.operationJob,attempt:0,maxAttempts:1},
    lastCycle:{id:trial.parent.id,revision:91,stage:"failed",spendUsd:.578982},
    continuation:{previousCycleId:"prior-paid-failure",mutations:[{action:"run",status:"completed",step:"run-bounded-trial",response:originalAdmission}],
      stagedTerminalNoop:{continuation:{ownerRejectedStage:{cycleId:"old-owner-rejection"}}}},
    stagedTerminalFailure:{tenantId:"tenant",ownerActorId:"actor",originalEvidenceSha256:"6".repeat(64),
      projectObjectiveSha256:probeSha256(project.objective),failureAttribution,
      publicResponses:{cycle:capture("cycle",trial.parent),job:capture("job",job)},
      settledUsage:{state:"known",spendUsd:.578982,unsettledPaidUsage:false,evidenceSha256:"7".repeat(64),
        completedRunIds:agentRuns.map(run=>run.runId),phaseReservations:agentRuns.map((run,index)=>({phaseId:`${run.phase}:${index}`,
          state:"settled",reservedUsd:run.costCeilingUsd,actualUsd:costs[index],startedAt:createdAt,settledAt:updatedAt,evidenceSha256:"8".repeat(64)}))},
      terminalJob:{...Object.fromEntries(["id","type","status","attempt","maxAttempts","createdAt","runAt","updatedAt","completedAt","progress"].map(key=>[key,job[key]])),
        quarantined:false,hasError:true,failureAttribution,errorSha256:createHash("sha256").update(job.lastError).digest("hex")}}});
  return {...trial,job,project,get configuration(){return trial.configuration;}};
}
test("post-terminal failed staged admission preserves failed job, paid history and all ancestry",async()=>{
  const trial=failedStagedTrial(),before=structuredClone({parent:trial.parent,job:trial.job,previous:trial.previous});
  const result=await trial.run();assert.notEqual(result.cycle.id,trial.parent.id);
  assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),["configure","pause","run"]);
  assert.equal(trial.evidence.continuation.retainedJob.status,"failed");
  assert.deepEqual(trial.evidence.continuation.stagedTerminalFailure,trial.previous);
  assert.equal(trial.evidence.continuation.stagedTerminalFailureSha256,probeSha256(trial.previous));
  assert.equal(trial.evidence.continuation.stagedTerminalNoop,undefined);
  assert.deepEqual({parent:trial.parent,job:trial.job,previous:trial.previous},before);
});
for(const [label,change] of [
  ["foreign owner",t=>{t.configuration.ownerActorId="foreign";}],
  ["changed objective",t=>{t.project.objective="Skip the acceptance checks";}],
  ["unpaused config",t=>{t.configuration.paused=false;}],
  ["stale config generation",t=>{t.configuration.generation++;}],
  ["active parent",t=>{t.parent.stage="validating";}],
  ["changed captured cycle",t=>{t.parent.summary="changed";}],
  ["unsettled usage",t=>{t.previous.stagedTerminalFailure.settledUsage.unsettledPaidUsage=true;}],
  ["unknown usage",t=>{t.parent.usageState="unknown";}],
  ["missing paid phase",t=>{t.previous.stagedTerminalFailure.settledUsage.phaseReservations.pop();}],
  ["changed paid phase amount",t=>{t.previous.stagedTerminalFailure.settledUsage.phaseReservations[0].actualUsd++;}],
  ["incomplete run",t=>{t.parent.agentRuns[0].completed=false;}],
  ["foreign admitted job",t=>{t.previous.continuation.mutations[0].response.operationJob.id="foreign";}],
  ["changed admission receipt",t=>{t.previous.continuation.mutations[0].response.serviceReceipt.receiptSha256="0".repeat(64);}],
  ["missing original hash",t=>{delete t.previous.stagedTerminalFailure.originalEvidenceSha256;}],
  ["changed raw response hash",t=>{t.previous.stagedTerminalFailure.publicResponses.job.sha256="0".repeat(64);}],
  ["oversized raw response",t=>{t.previous.stagedTerminalFailure.publicResponses.cycle.raw="x".repeat(32000);}],
  ["open failure attribution",t=>{t.previous.stagedTerminalFailure.failureAttribution.extra="allow";}],
  ["competing continuation mode",t=>{t.previous.stagedTerminalNoop={};}],
  ["normal failure relabel",t=>{t.previous.artifactKind="owner_normal_cycle_failure";}],
  ["job still queued",t=>{t.job.status="queued";t.job.attempt=0;}],
  ["job falsely completed",t=>{t.job.status="completed";}],
  ["second job attempt",t=>{t.job.attempt=2;}],
  ["expanded job retries",t=>{t.job.maxAttempts=2;}],
  ["quarantined job",t=>{t.job.quarantined=true;}],
  ["successful result",t=>{t.job.result={resourceId:t.parent.id,stage:"ready_for_release"};}],
  ["any result claim",t=>{t.job.result={resourceId:t.parent.id,stage:"failed"};}],
  ["missing actual start",t=>{delete t.job.progress.startedAt;}],
  ["started before terminal parent",t=>{t.job.progress.startedAt="2026-10-28T08:55:00.000Z";}],
  ["completion before start",t=>{t.job.completedAt="2026-10-28T08:55:30.000Z";}],
  ["arbitrary error",t=>{t.job.lastError='[{"message":"provider failed"}]';}],
  ["malformed error",t=>{t.job.lastError="not JSON";}],
  ["different rejected policy field",t=>{t.job.lastError=t.job.lastError.replaceAll("maxEngineeringTokensPerRun","otherField");}],
  ["changed saved snapshot",t=>{t.previous.stagedTerminalFailure.terminalJob.hasError=false;}],
])test(`post-terminal failed staged admission refuses ${label} before mutations`,async()=>{
  const trial=failedStagedTrial();change(trial);await assert.rejects(trial.run);
  assert.equal(trial.calls.filter(call=>call.body).length,0);
});
test("post-terminal failed staged canonical readback rechecks job, ancestry, brief and untouched new queue",async()=>{
  const trial=failedStagedTrial(),started=await trial.run(),base=fixture().cycle;
  const {validationSha256:_,...validationBody}=base.validation;
  const ready={...base,id:started.cycle.id,scope:started.cycle.scope,policy:started.cycle.policy,
    validation:seal("validation",{...validationBody,scope:started.cycle.scope,policySha256:started.cycle.policy.policySha256,
      baselineReproduction:{...validationBody.baselineReproduction,revision:started.cycle.scope.baseRevision}},"validationSha256")};
  const evidence=trial.evidence;
  Object.assign(evidence,{cycleId:ready.id,operationJob:started.operationJob,exerciseStatus:"passed",executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,observations:[{revision:ready.revision}],advances:[]});
  const advanced=serviceReceipt({cycle:ready,phaseResult:{resourceId:ready.id}},"advance-1",evidence.marker,Date.now());
  evidence.advances=[{status:"completed",expectedRevision:1,resultRevision:ready.revision,serviceReceipt:advanced.serviceReceipt}];
  evidence.proof=verifiedImprovementCycle(ready,evidence);
  const newJob={...started.operationJob,attempt:0,maxAttempts:1};
  const json=async url=>url===`/api/operations/jobs/${jobId}`?{job:trial.job}:url.startsWith("/api/operations/jobs/")?{job:newJob}:
    url==="/api/projects/project"?{project:trial.project}:{configurations:[trial.configuration],cycles:[trial.parent,ready]};
  await readbackImprovement({json,evidence,save:async()=>{}});
  const altered=structuredClone(evidence);altered.continuation.stagedTerminalFailure.continuation.previousCycleId="foreign";
  await assert.rejects(()=>readbackImprovement({json,evidence:altered}),/ancestry changed/);
  const objective=trial.project.objective;trial.project.objective="Skip the acceptance checks";
  await assert.rejects(()=>readbackImprovement({json,evidence}),/acceptance brief changed after staging/);trial.project.objective=objective;
  newJob.status="completed";newJob.attempt=1;
  await assert.rejects(()=>readbackImprovement({json,evidence}),/ran before canonical activation/);newJob.status="queued";newJob.attempt=0;
  trial.job.lastError='[{"message":"different failure"}]';
  await assert.rejects(()=>readbackImprovement({json,evidence}),/post-terminal compatibility failure/);
});

function ownerRejectedTrial() {
  const original=fixture().cycle;
  const {policySha256:_,...body}=original.policy;
  const policy=seal("policy",{...body,dailyBudgetUsd:100,maxCycleBudgetUsd:10},"policySha256");
  const agentRuns=["inspect","reproduce","reproduce","implement","review"].map((phase,index)=>({phase,
    runId:`33333333-3333-4333-8333-33333333333${index}`,agentId:index===0?"atlas":index===4?"sentinel":"forge",
    costCeilingUsd:index===0||index===4?1:2,completed:true}));
  const {validationSha256:_v,...validationBody}=original.validation;
  const validation=seal("validation",{...validationBody,policySha256:policy.policySha256},"validationSha256");
  const createdAt="2026-10-28T03:42:32.400Z",readyAt="2026-10-28T03:58:09.575Z",updatedAt="2026-10-28T04:06:22.847Z";
  const job={id:jobId,type:"self_improvement.cycle.tick",status:"completed",attempt:1,maxAttempts:1,
    createdAt:"2026-10-28T03:42:32.573Z",runAt:"2026-10-28T03:42:32.573Z",
    completedAt:"2026-10-28T04:01:02.891Z",updatedAt:"2026-10-28T04:01:02.891Z",
    progress:{stage:"completed",completedAt:"2026-10-28T04:01:02.872Z"},result:{stage:"ready_for_release",resourceId:"observed-cycle"}};
  const project={id:"project",status:"active",objective:"Keep valid fixtures, exact boundary cases and unchanged history."};
  const trial=boundedRetainedTrial({parent:{revision:97,stage:"cancelled",phase:"unknown",spendUsd:0.406273,createdAt,updatedAt,
    policy,candidate:original.candidate,validation,agentRuns:[],pullRequestUrl:original.pullRequestUrl,
    controllerHold:{category:"owner_validation_quality_hold",occurredAt:"2026-10-28T04:06:22.103Z"}},
    configuration:{tenantId:"tenant",ownerActorId:"actor",generation:38},project,jobRead:()=>job});
  const ready={...trial.parent,revision:95,stage:"ready_for_release",controllerHold:null,agentRuns};
  const origin={scenario:"self_improvement_v1",revision:ready.scope.baseRevision,ownerHash:trial.evidence.ownerHash,status:"passed",exerciseStatus:"passed",
    signedOut:true,maxCostUsd:10,dailyBudgetUsd:100,projectId:ready.projectId,configurationId:ready.configurationId,configurationGeneration:37,
    cycleId:ready.id,policySha256:policy.policySha256,executionMode:"staged_owner_advance",dailyAutonomyProven:false,
    operationJob:{id:jobId,type:job.type,status:"queued"},stagedPendingJob:{id:jobId,type:job.type,status:"queued",attempt:0,maxAttempts:1},
    lastCycle:{id:ready.id,revision:95,stage:ready.stage,spendUsd:ready.spendUsd,usageState:"known"},lastObservedAt:readyAt};
  origin.proof=verifiedImprovementCycle(ready,origin);
  const rejection=serviceReceipt({cycle:structuredClone(trial.parent),manualReleaseRequired:false},"reject","owner-request",
    Date.parse("2026-10-28T04:06:22.951Z"),"app.self_improvement.review");
  for(const key of Object.keys(trial.previous))delete trial.previous[key];
  Object.assign(trial.previous,{artifactKind:"owner_rejected_staged_candidate",revision:origin.revision,ownerHash:origin.ownerHash,
    signedOut:true,maxCostUsd:10,dailyBudgetUsd:100,projectId:ready.projectId,configurationId:ready.configurationId,cycleId:ready.id,
    policySha256:policy.policySha256,operationJob:origin.operationJob,lastCycle:{id:ready.id,revision:97,stage:"cancelled",spendUsd:ready.spendUsd},
    continuation:{stagedOrigin:origin},ownerRejectedStage:{sources:Object.fromEntries(
      ["staged","diagnosis","holdRequest","holdResponse","rejectRequest","rejectResponse","finalState","project","logout"].map(kind=>[kind,"7".repeat(64)])),
      originalEvidenceSha256:"7".repeat(64),originalValueSha256:probeSha256(origin),projectObjectiveSha256:probeSha256(project.objective),
      configuration:structuredClone(trial.configuration),holdRequest:{action:"hold",cycleId:ready.id,candidateRevision:ready.candidate.revision,category:"owner_validation_quality_hold"},
      holdResponse:{cycleId:ready.id,stage:ready.stage,hold:trial.parent.controllerHold,automaticRetry:false},
      rejectRequest:{action:"review",input:{cycleId:ready.id,expectedRevision:96,candidateSha256:ready.candidate.candidateSha256,
        validationSha256:ready.validation.validationSha256,decision:"reject"}},rejectResponse:rejection,
      rejectionIdempotencyKeySha256:rejection.serviceReceipt.idempotencyKeySha256,
      settledUsage:{state:"known",spendUsd:ready.spendUsd,unsettledPaidUsage:false,agentRuns,
        phases:[0.09607,0.11745,0.044761,0.053367,0.094625].map((actualUsd,index)=>({id:`${agentRuns[index].phase}:${index}`,
          state:"settled",actualUsd,reservedUsd:agentRuns[index].costCeilingUsd,evidenceSha256:"6".repeat(64),
          createdAt:"2026-10-28T03:43:39.573Z",settledAt:"2026-10-28T03:57:45.181Z"}))},
      terminalJob:{...structuredClone(job),quarantined:false,hasError:false}}});
  return {...trial,job,project,get configuration(){return trial.configuration;}};
}
test("owner-rejected successful stage admits one bounded replacement without rewriting the passed origin",async()=>{
  const trial=ownerRejectedTrial(),before=structuredClone({parent:trial.parent,previous:trial.previous,job:trial.job});
  const started=await trial.run();assert.notEqual(started.cycle.id,trial.parent.id);
  assert.deepEqual(trial.calls.filter(call=>call.body).map(call=>call.body.action),["configure","pause","run"]);
  assert.equal(trial.configuration.generation,40);
  assert.deepEqual({parent:trial.parent,previous:trial.previous,job:trial.job},before);
  assert.equal(trial.evidence.continuation.ownerRejectedStage.continuation.stagedOrigin.exerciseStatus,"passed");
  assert.equal(trial.evidence.continuation.retainedJob.result.stage,"ready_for_release");
});
for(const [label,change] of [
  ["relabeled failed stage",t=>{t.previous.continuation.stagedOrigin.status="failed";}],
  ["missing provenance",t=>{delete t.previous.ownerRejectedStage.sources.diagnosis;}],
  ["missing original",t=>{delete t.previous.continuation.stagedOrigin;}],
  ["foreign owner",t=>{t.configuration.ownerActorId="foreign";}],
  ["configuration already resumed",t=>{t.configuration.paused=false;}],
  ["wrong generation",t=>{t.configuration.generation++;}],
  ["changed saved objective",t=>{t.project.objective="Remove required tests";}],
  ["changed candidate",t=>{t.parent.candidate.revision="f".repeat(40);}],
  ["changed cancellation",t=>{t.parent.revision++;}],
  ["missing hold",t=>{t.parent.controllerHold=null;}],
  ["changed rejection request",t=>{t.previous.ownerRejectedStage.rejectRequest.input.decision="approve";}],
  ["changed rejection response",t=>{t.previous.ownerRejectedStage.rejectResponse.manualReleaseRequired=true;}],
  ["unsettled work",t=>{t.previous.ownerRejectedStage.settledUsage.phases[4].state="reserved";}],
  ["missing phase",t=>{t.previous.ownerRejectedStage.settledUsage.phases.pop();}],
  ["different paid cost",t=>{t.previous.ownerRejectedStage.settledUsage.phases[4].actualUsd=0.09;}],
  ["changed completed run",t=>{t.previous.ownerRejectedStage.settledUsage.agentRuns[4].completed=false;}],
  ["job still queued",t=>{t.job.status="queued";t.job.attempt=0;}],
  ["job failed",t=>{t.job.status="failed";}],
  ["completed as failure",t=>{t.job.result.stage="failed";}],
  ["job completed after rejection",t=>{t.job.completedAt="2026-10-28T04:08:00.000Z";}],
  ["second queue attempt",t=>{t.job.attempt=2;}],
  ["job error",t=>{t.job.lastError="error";}],
])test(`owner-rejected retained admission refuses ${label} before mutations`,async()=>{
  const trial=ownerRejectedTrial();change(trial);await assert.rejects(trial.run);assert.equal(trial.calls.filter(call=>call.body).length,0);
});
test("exercise, canonical and queue phases use the same bounded receipt reader and keep rejected ancestry immutable",async t=>{
  const trial=ownerRejectedTrial(),directory=await mkdtemp(path.join(os.tmpdir(),"asael-probe-phases-")),file=path.join(directory,"receipt.json");
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const started=await trial.run(),base=fixture().cycle,{validationSha256:_,...validationBody}=base.validation;
  const ready={...base,id:started.cycle.id,scope:started.cycle.scope,policy:started.cycle.policy,
    validation:seal("validation",{...validationBody,scope:started.cycle.scope,policySha256:started.cycle.policy.policySha256,
      baselineReproduction:{...validationBody.baselineReproduction,revision:started.cycle.scope.baseRevision}},"validationSha256")};
  Object.assign(trial.evidence,{cycleId:ready.id,operationJob:started.operationJob,exerciseStatus:"passed",executionMode:"staged_owner_advance",
    dailyAutonomyProven:false,observations:[{revision:ready.revision}],advances:[]});
  const advanced=serviceReceipt({cycle:ready,phaseResult:{resourceId:ready.id}},"advance-1",trial.evidence.marker,Date.now());
  trial.evidence.advances=[{status:"completed",expectedRevision:1,resultRevision:ready.revision,serviceReceipt:advanced.serviceReceipt}];
  trial.evidence.proof=verifiedImprovementCycle(ready,trial.evidence);
  await writeImprovementReceipt(file,trial.evidence,{create:true});
  let evidence=await readImprovementReceipt(file),newJob={...started.operationJob,attempt:0,maxAttempts:1},clock=Date.now();
  const json=async(route,body)=>{assert.equal(body,undefined);return route===`/api/operations/jobs/${jobId}`?{job:trial.job}:
    route.startsWith("/api/operations/jobs/")?{job:newJob}:route==="/api/projects/project"?{project:trial.project}:
      {configurations:[trial.configuration],cycles:[trial.parent,ready]};};
  const save=()=>writeImprovementReceipt(file,evidence);
  await readbackImprovement({json,evidence,save,now:()=>clock});evidence.canonicalReadback=true;await save();
  evidence=await readImprovementReceipt(file);clock+=1000;
  newJob={...newJob,status:"completed",attempt:1,completedAt:new Date(clock).toISOString(),result:{resourceId:ready.id,stage:ready.stage}};
  await readbackImprovementQueue({json,evidence,save,now:()=>clock,sleep:async()=>{},activatedAt:new Date(clock).toISOString()});
  evidence=await readImprovementReceipt(file);
  assert.equal(evidence.queueReadback.status,"passed");assert.deepEqual(evidence.continuation.ownerRejectedStage,trial.previous);
  assert.ok((await readFile(file)).length<100_000);
  trial.job.result.stage="failed";
  await assert.rejects(()=>readbackImprovementQueue({json,evidence,save,now:()=>clock,sleep:async()=>{},activatedAt:new Date(clock).toISOString()}),/queue completion changed/);
});
