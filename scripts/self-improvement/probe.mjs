import { createHash } from "node:crypto";

const requiredChecks = ["focused_regression", "adjacent_regression", "typecheck", "independent_review"];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const probeSha256 = value => createHash("sha256").update(canonical(value)).digest("hex");
function sealed(kind, value, field) {
  requireValue(value && typeof value === "object", `Missing ${kind} receipt`);
  const { [field]: actual, ...body } = value;
  requireValue(actual === probeSha256({contract:"asael-self-improvement",version:1,kind,value:body}), `Changed ${kind} receipt`);
}
export function improvementProbeMethod(path, body, phase) {
  requireValue(path.startsWith("/api/") && !path.includes("#"), "Invalid improvement probe path");
  const method = body === undefined ? "GET" : "POST";
  requireValue(phase !== "readback" || method === "GET" || ["/api/auth/login","/api/auth/logout"].includes(path), "Canonical improvement readback cannot mutate or advance work");
  requireValue(!(path === "/api/self-improvement" && body?.action === "advance"), "Autonomous improvement verification cannot advance agent work");
  return method;
}
export function verifiedImprovementCycle(cycle, expected) {
  requireValue(cycle?.id === expected.cycleId && cycle.projectId === expected.projectId && cycle.configurationId === expected.configurationId,
    "The improvement cycle scope changed");
  requireValue(["review_required","ready_for_release"].includes(cycle.stage), `Improvement ended at ${cycle.stage || "unknown"}; a reviewed repair is unproven`);
  requireValue(cycle.usageState === "known" && Number.isFinite(cycle.spendUsd) && cycle.spendUsd >= 0 && cycle.spendUsd <= 10 && cycle.dailyReservationUsd === 10,
    "Improvement usage is unknown or exceeds the $10 reservation");
  sealed("policy",cycle.policy,"policySha256"); sealed("candidate",cycle.candidate,"candidateSha256"); sealed("validation",cycle.validation,"validationSha256");
  requireValue(cycle.policy.dailyBudgetUsd === 10 && cycle.policy.autoReleaseRoutineChanges === true && cycle.policy.notifyOutcomes === false && cycle.policy.policySha256 === expected.policySha256,
    "The staged improvement policy changed");
  const candidate=cycle.candidate, validation=cycle.validation;
  requireValue(candidate.candidateSha256 === validation.candidateSha256 && candidate.workspaceSha256 === validation.workspaceSha256 &&
    candidate.revision === validation.candidateRevision && cycle.policy.policySha256 === validation.policySha256 &&
    probeSha256(cycle.scope) === probeSha256(validation.scope), "Candidate validation does not bind the exact source and policy");
  requireValue(cycle.scope.baseRevision === expected.revision,"The repair did not start from this exact feature release");
  requireValue(validation.baselineReproduction?.revision === cycle.scope.baseRevision && validation.baselineReproduction.failedCases > 0 &&
    validation.baselineReproduction.executedCases >= validation.baselineReproduction.failedCases, "A failing baseline reproduction is missing");
  for (const kind of requiredChecks) requireValue(validation.checks.some(check => check.kind === kind && check.outcome === "passed" &&
    check.declaredCases > 0 && check.executedCases === check.declaredCases && check.failedCases === 0 &&
    check.candidateRevision === candidate.revision && check.workspaceSha256 === candidate.workspaceSha256), `Missing actual passing ${kind} evidence`);
  requireValue(["atlas","forge","sentinel"].every(agent => cycle.agentRuns?.some(run => run.agentId === agent && run.completed)),
    "Atlas, Forge and Sentinel did not all complete their own work");
  requireValue(/^https:\/\/github\.com\/benniejoseph\/OmniAgentOS\/pull\/[1-9][0-9]*$/.test(cycle.pullRequestUrl || "") &&
    /^[a-f0-9]{40}$/.test(candidate.revision) && cycle.builderSessionId && cycle.checkpointId && cycle.verificationId && cycle.deliveryId,
    "The reviewed repair has no durable Builder and GitHub delivery receipts");
  return {cycleId:cycle.id,projectId:cycle.projectId,configurationId:cycle.configurationId,stage:cycle.stage,
    policySha256:cycle.policy.policySha256,candidateSha256:candidate.candidateSha256,validationSha256:validation.validationSha256,
    sourceCandidateRevision:candidate.revision,baseRevision:cycle.scope.baseRevision,workspaceSha256:candidate.workspaceSha256,
    pullRequestUrl:cycle.pullRequestUrl,spendUsd:cycle.spendUsd,agentRunsSha256:probeSha256(cycle.agentRuns),
    builderSessionId:cycle.builderSessionId,checkpointId:cycle.checkpointId,verificationId:cycle.verificationId,deliveryId:cycle.deliveryId};
}
export async function exerciseImprovement({json,evidence,save,sleep,now=Date.now}) {
  const before=await json("/api/self-improvement");
  requireValue(before.github?.configured === true, "Hosted GitHub App is unavailable");
  requireValue(!before.configurations.some(item => item.repositoryId === "1260961340"), "An existing repository policy requires explicit reconciliation; the probe will not replace it");
  const {project}=await json("/api/projects",{title:`Asael improvement verification ${evidence.marker.slice(0,8)}`,
    objective:"Investigate and repair an observed Visual Studio duplication defect. In src/components/studio/state.ts, duplicateGraphNodes appears to check the node limit but can copy connections beyond the graph limit. A valid graph with nine reference asset nodes, nine output gallery nodes and all 81 image-to-media connections becomes 36 nodes and 162 connections after duplicating every node; graph validation then rejects saving with invalid_graph. Independently inspect and reproduce this behavior before changing the implementation. Expected behavior: refuse an over-limit duplication before mutating history, explain the connection limit clearly, and allow a result with exactly 160 connections. Add a focused reproduction in src/components/studio/duplicate-connection-limit.test.ts; inspect src/components/studio/state.test.ts and src/lib/studio/graph.test.ts for adjacent regression coverage. Atlas plans, Forge reproduces and repairs, and Sentinel independently reviews real execution receipts. Keep all changes in the proposed candidate; this verification does not approve, merge or deploy it.",status:"active"},"project");
  requireValue(project?.id,"The synthetic project has no durable identity");evidence.projectId=project.id;await save();
  const {configuration}=await json("/api/self-improvement",{action:"configure",input:{projectId:project.id,repositoryId:"1260961340",dailyBudgetUsd:10,
    autoReleaseRoutineChanges:true,notifyOutcomes:false,timeZone:"Asia/Kolkata",dailyHour:3}},"configure");
  requireValue(configuration?.id && configuration.projectId === project.id && configuration.generation === 1 && !configuration.paused && configuration.policy.notifyOutcomes === false,
    "The synthetic improvement configuration is not isolated");
  evidence.configurationId=configuration.id;evidence.configurationGeneration=configuration.generation;evidence.policySha256=configuration.policy.policySha256;await save();
  const started=await json("/api/self-improvement",{action:"run",input:{configurationId:configuration.id,expectedGeneration:configuration.generation}},"run");
  requireValue(started.cycle?.id,"The queued improvement cycle was not admitted");evidence.cycleId=started.cycle.id;await save();
  const deadline=now()+45*60_000;
  evidence.executionMode="normal_background_queue";
  evidence.observations=[];
  evidence.pollCount=0;
  while(now()<deadline) {
    const state=await json("/api/self-improvement",undefined,undefined,{timeoutMs:Math.max(1,deadline-now())}),
      cycle=state.cycles.find(item=>item.id===evidence.cycleId);
    requireValue(cycle && cycle.projectId===evidence.projectId && cycle.configurationId===evidence.configurationId,
      "The exact staged cycle disappeared or changed scope");
    const previous=evidence.lastCycle;
    requireValue(!previous || cycle.revision>=previous.revision,"The staged cycle revision moved backwards");
    const observedAt=new Date(now()).toISOString();
    evidence.lastCycle={id:cycle.id,revision:cycle.revision,stage:cycle.stage,phase:cycle.phase,spendUsd:cycle.spendUsd,usageState:cycle.usageState};
    evidence.lastObservedAt=observedAt;
    evidence.pollCount++;
    if(!previous || previous.revision!==cycle.revision || previous.stage!==cycle.stage || previous.phase!==cycle.phase) {
      evidence.observations.push({...evidence.lastCycle,observedAt});
    }
    await save();
    if(["review_required","ready_for_release","no_change","failed","cancelled","succeeded","rolled_back"].includes(cycle.stage)) {
      evidence.proof=verifiedImprovementCycle(cycle,evidence);await save();return;
    }
    requireValue(["observing","planned","implementing","validating","correcting"].includes(cycle.stage),"Unexpected staged improvement state");
    // Asael's normal Fly background lane owns every phase. The release probe
    // only observes this one already queued cycle; it cannot advance or tick it.
    await sleep(Math.min(15_000,Math.max(0,deadline-now())));
  }
  throw new Error("The queued Asael cycle did not produce a reviewed repair within 45 minutes; it will not be repeated automatically");
}
export async function pauseProbeConfiguration({json,evidence,save}) {
  // Pausing changes the generation. A successful candidate must retain its exact
  // policy generation so the later installed controller can publish that work.
  if(evidence.proof)return;
  if(!evidence.projectId)return;
  const state=await json("/api/self-improvement");
  const configuration=state.configurations.find(item=>item.projectId===evidence.projectId && item.repositoryId==="1260961340");
  if(!configuration)return;
  requireValue(!evidence.configurationId || configuration.id===evidence.configurationId,"Cleanup configuration identity changed");
  if(!configuration.paused) await json("/api/self-improvement",{action:"pause",input:{configurationId:configuration.id,expectedGeneration:configuration.generation,paused:true}},`pause-${configuration.generation}`);
  const checked=await json("/api/self-improvement");
  requireValue(checked.configurations.some(item=>item.id===configuration.id && item.projectId===evidence.projectId && item.paused),"Synthetic daily scheduling did not pause");
  evidence.configurationPaused=true;await save();
}
export async function readbackImprovement({json,evidence}) {
  requireValue(evidence.exerciseStatus==="passed" && evidence.proof,"Staged repair evidence is not complete");
  requireValue(evidence.executionMode==="normal_background_queue" && Array.isArray(evidence.observations) &&
    evidence.observations.length>0 && evidence.advances===undefined,"Staged evidence did not observe autonomous queued work");
  const state=await json("/api/self-improvement");
  requireValue(state.configurations.some(item=>item.id===evidence.configurationId && item.projectId===evidence.projectId && item.generation===evidence.configurationGeneration && !item.paused && item.policy.notifyOutcomes===false && item.policy.policySha256===evidence.policySha256),"The retained trial policy generation changed");
  const cycle=state.cycles.find(item=>item.id===evidence.cycleId);
  requireValue(probeSha256(verifiedImprovementCycle(cycle,evidence))===probeSha256(evidence.proof),"Canonical cycle differs from the exact staged repair");
}
