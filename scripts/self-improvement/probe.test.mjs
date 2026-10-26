import assert from "node:assert/strict";
import test from "node:test";
import { improvementProbeMethod, verifiedImprovementCycle, exerciseImprovement, pauseProbeConfiguration, readbackImprovement, probeSha256 } from "./probe.mjs";

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

async function queuedProbe(observe) {
  const {cycle,evidence:expected}=fixture();let configured=false,started=false,clock=1000,reads=0;
  const configuration={id:"config",projectId:"project",repositoryId:"1260961340",generation:1,paused:false,policy:cycle.policy};
  const evidence={revision:expected.revision,marker:"queued",observations:[]};
  const actions=[];
  const json=async(path,body)=>{
    if(!body)return {github:{configured:true},configurations:configured?[configuration]:[],cycles:started?[observe({cycle,read:reads++,clock})]:[]};
    actions.push(body.action||"project");
    if(path==="/api/projects")return {project:{id:"project"}};
    if(body.action==="configure"){assert.equal(body.input.autoReleaseRoutineChanges,true);assert.equal(body.input.notifyOutcomes,false);configured=true;return {configuration};}
    if(body.action==="run"){started=true;return {cycle:{id:"cycle"}};}
    throw new Error("The observer must never advance, tick, approve, or restart work");
  };
  const run=()=>exerciseImprovement({json,evidence,save:async()=>{},sleep:async(ms)=>{clock+=ms;},now:()=>clock});
  return {run,evidence,actions,json,cycle};
}

test("the autonomous proof observes normal queued transitions with only project/configure/run mutations",async()=>{
  const states=[[2,"observing","inspect"],[2,"observing","inspect"],[4,"planned","plan"],[6,"implementing","repair"],[8,"validating","review"]];
  const probe=await queuedProbe(({cycle,read,clock})=>read<states.length?{...cycle,revision:states[read][0],stage:states[read][1],phase:states[read][2],
    executionLeaseExpiresAt:new Date(clock+60_000).toISOString()}:cycle);
  await probe.run();
  assert.deepEqual(probe.actions,["project","configure","run"]);
  assert.equal(probe.evidence.executionMode,"normal_background_queue");
  assert.equal(probe.evidence.pollCount,6);
  assert.deepEqual(probe.evidence.observations.map(item=>item.revision),[2,4,6,8,12]);
  assert.ok(probe.evidence.observations.every(item=>Number.isFinite(Date.parse(item.observedAt))));
  await pauseProbeConfiguration({json:async()=>{throw new Error("Successful candidate must stay unchanged")},evidence:probe.evidence,save:async()=>{}});
  probe.evidence.exerciseStatus="passed";
  await readbackImprovement({json:probe.json,evidence:probe.evidence});
  await assert.rejects(()=>readbackImprovement({json:probe.json,evidence:{...probe.evidence,executionMode:"manually_advanced"}}),/autonomous queued work/);
  probe.cycle.validation={...probe.cycle.validation,validationSha256:"0".repeat(64)};
  await assert.rejects(()=>readbackImprovement({json:probe.json,evidence:probe.evidence}),/Changed validation/);
});

test("exercise transport cannot call the manual advance utility",()=>{
  assert.throws(()=>improvementProbeMethod("/api/self-improvement",{action:"advance"},"exercise"),/cannot advance/);
});

test("the compatibility trial rejects even a correctly sealed policy with notifications enabled",()=>{
  const {cycle,evidence}=fixture();
  const {policySha256:_,...body}=cycle.policy;
  cycle.policy=seal("policy",{...body,notifyOutcomes:true},"policySha256");
  evidence.policySha256=cycle.policy.policySha256;
  assert.throws(()=>verifiedImprovementCycle(cycle,evidence),/staged improvement policy changed/);
});

test("an unchanged queued cycle times out after 45 minutes without manual assistance or replay",async()=>{
  const probe=await queuedProbe(({cycle})=>({...cycle,revision:2,stage:"observing",phase:"inspect"}));
  await assert.rejects(probe.run,/within 45 minutes/);
  assert.deepEqual(probe.actions,["project","configure","run"]);
  assert.equal(probe.evidence.pollCount,180);
  assert.equal(probe.evidence.observations.length,1);
  assert.equal(probe.evidence.proof,undefined);
});

test("failed autonomous work and changed scope remain failures",async()=>{
  const failed=await queuedProbe(({cycle,read})=>({...cycle,revision:read?3:2,stage:read?"failed":"observing",phase:"inspect"}));
  await assert.rejects(failed.run,/ended at failed/);assert.deepEqual(failed.actions,["project","configure","run"]);
  const foreign=await queuedProbe(({cycle})=>({...cycle,projectId:"foreign"}));
  await assert.rejects(foreign.run,/changed scope/);assert.equal(foreign.evidence.proof,undefined);
});
