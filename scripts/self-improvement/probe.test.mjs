import assert from "node:assert/strict";
import test from "node:test";
import { improvementProbeMethod, verifiedImprovementCycle, exerciseImprovement, pauseProbeConfiguration, readbackImprovement, probeSha256 } from "./probe.mjs";

const seal=(kind,value,field)=>({...value,[field]:probeSha256({contract:"asael-self-improvement",version:1,kind,value})});
function fixture() {
  const revision="a".repeat(40), source="b".repeat(40),workspace="c".repeat(64);
  const policy=seal("policy",{dailyBudgetUsd:10,autoReleaseRoutineChanges:true},"policySha256");
  const scope={tenantId:"tenant",ownerActorId:"actor",baseRevision:revision,repository:{owner:"benniejoseph",name:"OmniAgentOS",defaultBranch:"main"}};
  const candidate=seal("candidate",{revision:source,workspaceSha256:workspace,changedFiles:[{path:"src/feature.ts"}]},"candidateSha256");
  const checks=["focused_regression","adjacent_regression","typecheck","independent_review"].map(kind=>({kind,outcome:"passed",declaredCases:1,executedCases:1,failedCases:0,candidateRevision:source,workspaceSha256:workspace}));
  const validation=seal("validation",{scope,policySha256:policy.policySha256,candidateSha256:candidate.candidateSha256,workspaceSha256:workspace,candidateRevision:source,
    baselineReproduction:{revision,failedCases:1,executedCases:1},checks},"validationSha256");
  const cycle={id:"cycle",projectId:"project",configurationId:"config",revision:12,stage:"ready_for_release",usageState:"known",spendUsd:0.5,dailyReservationUsd:10,
    scope,policy,candidate,validation,agentRuns:["atlas","forge","sentinel"].map(agentId=>({agentId,completed:true})),
    pullRequestUrl:"https://github.com/benniejoseph/OmniAgentOS/pull/123",builderSessionId:"session",checkpointId:"checkpoint",verificationId:"verification",deliveryId:"delivery"};
  return {cycle,evidence:{revision,cycleId:"cycle",projectId:"project",configurationId:"config",configurationGeneration:1,policySha256:policy.policySha256}};
}
test("canonical readback has no resource mutation or advance authority",()=>{
  assert.equal(improvementProbeMethod("/api/self-improvement",undefined,"readback"),"GET");
  assert.equal(improvementProbeMethod("/api/auth/logout",{},"readback"),"POST");
  for(const action of ["run","advance","configure","review","pause"])assert.throws(()=>improvementProbeMethod("/api/self-improvement",{action},"readback"),/cannot mutate/);
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
test("one staged exercise advances exact revisions and preserves a successful candidate generation",async()=>{
  const {cycle,evidence:expected}=fixture();let configured=false,started=false,advanced=false;
  const actions=[];const configuration={id:"config",projectId:"project",repositoryId:"1260961340",generation:1,paused:false,policy:cycle.policy};
  const evidence={revision:expected.revision,marker:"fixture",advances:[]};
  const json=async(path,body)=>{
    if(!body)return {github:{configured:true},configurations:configured?[configuration]:[],cycles:started?[advanced?cycle:{...cycle,revision:2,stage:"observing",phase:"inspect"}]:[]};
    actions.push(body.action||"project");
    if(path==="/api/projects")return {project:{id:"project"}};
    if(body.action==="configure"){assert.equal(body.input.autoReleaseRoutineChanges,true);configured=true;return {configuration};}
    if(body.action==="run"){started=true;return {cycle:{id:"cycle"}};}
    if(body.action==="advance"){assert.equal(body.input.expectedRevision,2);advanced=true;return {cycle};}
    throw new Error("Unexpected action");
  };
  await exerciseImprovement({json,evidence,save:async()=>{},sleep:async()=>{}});
  assert.deepEqual(actions,["project","configure","run","advance"]);
  await pauseProbeConfiguration({json:async()=>{throw new Error("Successful generation must stay unchanged")},evidence,save:async()=>{}});
  evidence.exerciseStatus="passed";
  await readbackImprovement({json,evidence});
  cycle.validation={...cycle.validation,validationSha256:"0".repeat(64)};
  await assert.rejects(()=>readbackImprovement({json,evidence}),/Changed validation/);
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

async function concurrentProbe({observe,advance}) {
  const {cycle,evidence:expected}=fixture();let configured=false,started=false,clock=1000,reads=0;
  const configuration={id:"config",projectId:"project",repositoryId:"1260961340",generation:1,paused:false,policy:cycle.policy};
  const evidence={revision:expected.revision,marker:"concurrency",advances:[]};
  const actions=[];
  const json=async(path,body)=>{
    if(!body)return {github:{configured:true},configurations:configured?[configuration]:[],cycles:started?[observe({cycle,read:reads++,clock})]:[]};
    actions.push(body.action||"project");
    if(path==="/api/projects")return {project:{id:"project"}};
    if(body.action==="configure"){configured=true;return {configuration};}
    if(body.action==="run"){started=true;return {cycle:{id:"cycle"}};}
    if(body.action==="advance")return advance({cycle,body});
    throw new Error("Unexpected action");
  };
  const run=()=>exerciseImprovement({json,evidence,save:async()=>{},sleep:async(ms)=>{clock+=ms;},now:()=>clock});
  return {run,evidence,actions};
}

test("active worker leases are observed without issuing another advance",async()=>{
  const probe=await concurrentProbe({
    observe:({cycle,read,clock})=>read<2?{...cycle,revision:2,stage:"observing",phase:"inspect",executionLeaseExpiresAt:new Date(clock+20_000).toISOString()}:cycle,
    advance:()=>{throw new Error("A running worker must not be advanced");},
  });
  await probe.run();assert.deepEqual(probe.actions,["project","configure","run"]);assert.equal(probe.evidence.proof.cycleId,"cycle");
});

test("stale revision and transport ambiguity reconcile actual movement without replay",async()=>{
  for(const failure of [Object.assign(new Error("conflict"),{httpStatus:409,remoteError:"The improvement phase revision changed; read its current state before advancing."}),
    Object.assign(new Error("connection closed"),{requestOutcomeUncertain:true})]) {
    const probe=await concurrentProbe({
      observe:({cycle,read})=>read===0?{...cycle,revision:2,stage:"observing",phase:"inspect"}:cycle,
      advance:()=>{throw failure;},
    });
    await probe.run();assert.equal(probe.actions.filter(action=>action==="advance").length,1);assert.equal(probe.evidence.proof.cycleId,"cycle");
  }
});

test("an ambiguous unchanged revision stays recorded and is never retried",async()=>{
  const probe=await concurrentProbe({
    observe:({cycle})=>({...cycle,revision:2,stage:"observing",phase:"inspect"}),
    advance:()=>{throw Object.assign(new Error("connection closed"),{requestOutcomeUncertain:true});},
  });
  await assert.rejects(probe.run,/outcome is uncertain/);
  assert.equal(probe.actions.filter(action=>action==="advance").length,1);
  assert.deepEqual(probe.evidence.advanceAmbiguity,{revision:2,observedRevision:2,leaseActive:false});
});

test("a genuinely rejected or failed phase cannot be silently retried",async()=>{
  const rejection=await concurrentProbe({observe:({cycle})=>({...cycle,revision:2,stage:"observing",phase:"inspect"}),
    advance:()=>{throw Object.assign(new Error("budget exhausted"),{httpStatus:409,remoteError:"Daily budget exhausted."});}});
  await assert.rejects(rejection.run,/budget exhausted/);assert.equal(rejection.evidence.advances.length,1);
  const failed=await concurrentProbe({observe:({cycle,read})=>({...cycle,revision:read?3:2,stage:read?"failed":"observing",phase:"inspect"}),
    advance:()=>{throw Object.assign(new Error("connection closed"),{requestOutcomeUncertain:true});}});
  await assert.rejects(failed.run,/ended at failed/);assert.equal(failed.evidence.advances.length,1);
});
