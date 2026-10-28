import { createHash } from "node:crypto";

const requiredChecks = ["focused_regression", "adjacent_regression", "typecheck", "independent_review"];
const codingStages = ["observing", "planned", "implementing", "validating", "correcting"];
// Two deterministic test-preparation checks add deliveries, not paid work or time.
const maxAdvances = 23, advanceTimeoutMs = 270_000;
const jobType = "self_improvement.cycle.tick";
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const probeSha256 = value => createHash("sha256").update(canonical(value)).digest("hex");
export function improvementProbeError(value,secrets=[]) {
  let text=String(value);
  for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))text=text.replaceAll(secret,"[redacted]");
  return text.replace(/(https?|postgres(?:ql)?):\/\/[^\s/@]+:[^\s/@]+@/gi,"$1://[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g,"[redacted]")
    .slice(0,700);
}
function sealed(kind, value, field) {
  requireValue(value && typeof value === "object", `Missing ${kind} receipt`);
  const { [field]: actual, ...body } = value;
  requireValue(actual === probeSha256({contract:"asael-self-improvement",version:1,kind,value:body}), `Changed ${kind} receipt`);
}
export function improvementProbeMethod(path, body, phase) {
  requireValue(path.startsWith("/api/") && !path.includes("#"), "Invalid improvement probe path");
  requireValue(["exercise","readback","queue_readback"].includes(phase), "Invalid improvement probe mode");
  const method = body === undefined ? "GET" : "POST";
  requireValue(phase === "exercise" || method === "GET" || ["/api/auth/login","/api/auth/logout"].includes(path), "Canonical improvement readback cannot mutate or advance work");
  return method;
}

function requireCycleScope(cycle,evidence) {
  requireValue(cycle && cycle.id===evidence.cycleId && cycle.projectId===evidence.projectId && cycle.configurationId===evidence.configurationId,
    "The exact staged cycle disappeared or changed scope");
  requireValue(Number.isSafeInteger(cycle.revision) && cycle.revision>0 && cycle.scope?.baseRevision===evidence.revision &&
    cycle.policy?.policySha256===evidence.policySha256,"The admitted cycle revision or source policy changed");
  requireValue(cycle.usageState==="known" && Number.isFinite(cycle.spendUsd) && cycle.spendUsd>=0 && cycle.spendUsd<=10,
    "Improvement usage is unknown or exceeds the $10 reservation");
}

function requireJobIdentity(job,evidence) {
  requireValue(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(evidence.operationJob?.id || "") &&
    evidence.operationJob.type===jobType && job?.id===evidence.operationJob.id && job.type===jobType && job.maxAttempts===1,
    "The exact retained improvement job changed identity or type");
}

async function readPendingJob({json,evidence}) {
  requireValue(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(evidence.operationJob?.id || "") &&
    evidence.operationJob.type===jobType && evidence.operationJob.status==="queued","The admitted cycle has no exact queued job receipt");
  const {job}=await json(`/api/operations/jobs/${evidence.operationJob?.id}`);
  requireJobIdentity(job,evidence);
  requireValue(job.status==="queued" && job.attempt===0 && !job.completedAt && !job.lastError &&
    (!job.result || Object.keys(job.result).length===0),"The retained improvement job ran before canonical activation");
  return {id:job.id,type:job.type,status:job.status,attempt:job.attempt,maxAttempts:job.maxAttempts};
}

function verifiedMutationReceipt(response,cycle,evidence,step,operation) {
  const {serviceReceipt,...outcome}=response;
  requireValue(serviceReceipt && typeof serviceReceipt==="object","The owner advance has no application receipt");
  const {receiptSha256,...body}=serviceReceipt;
  const keySha256=createHash("sha256").update(`${cycle.scope.tenantId}\u0000improvement-smoke:${evidence.marker}:${step}`).digest("hex");
  requireValue(receiptSha256===probeSha256(body) && body.outcomeSha256===probeSha256(outcome) &&
    body.schemaVersion===1 && body.receiptKind==="app_service_receipt" && body.boundaryVersion==="p9.1-app-service-boundary:1" &&
    body.operation===operation && body.accessMode==="mutation" && body.action==="manage.workflow" &&
    body.resourceType==="self_improvement" && body.eventContract==="self-improvement-events.v1" &&
    body.idempotencyKeySha256===keySha256 && /^[a-f0-9]{64}$/.test(body.authoritySha256) && Number.isFinite(Date.parse(body.occurredAt)),
    "The owner mutation receipt does not bind its actual result and request");
  return serviceReceipt;
}
function verifiedAdvanceReceipt(response,cycle,evidence,step) {
  const serviceReceipt=verifiedMutationReceipt(response,cycle,evidence,step,"app.self_improvement.advance");
  requireValue(response.phaseResult?.resourceId===evidence.cycleId,"The owner advance returned a different cycle");
  return serviceReceipt;
}
export function verifiedImprovementCycle(cycle, expected) {
  requireValue(cycle?.id === expected.cycleId && cycle.projectId === expected.projectId && cycle.configurationId === expected.configurationId,
    "The improvement cycle scope changed");
  requireValue(["review_required","ready_for_release"].includes(cycle.stage), `Improvement ended at ${cycle.stage || "unknown"}; a reviewed repair is unproven`);
  requireValue(cycle.usageState === "known" && Number.isFinite(cycle.spendUsd) && cycle.spendUsd >= 0 && cycle.spendUsd <= 10 && cycle.dailyReservationUsd === 10,
    "Improvement usage is unknown or exceeds the $10 reservation");
  sealed("policy",cycle.policy,"policySha256"); sealed("candidate",cycle.candidate,"candidateSha256"); sealed("validation",cycle.validation,"validationSha256");
  requireValue(cycle.policy.dailyBudgetUsd === (expected.dailyBudgetUsd || 10) &&
    (cycle.policy.maxCycleBudgetUsd ?? cycle.policy.dailyBudgetUsd) === 10 &&
    cycle.policy.autoReleaseRoutineChanges === true && cycle.policy.notifyOutcomes === false && cycle.policy.policySha256 === expected.policySha256,
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
function verifiedRetryAdmission(started,parent,evidence) {
  requireValue(started?.outcome==="claimed" && started.cycle?.id && started.cycle.id!==parent.id &&
    (!evidence.cycleId || started.cycle.id===evidence.cycleId),"The explicit retry did not admit one new cycle");
  requireCycleScope(started.cycle,{...evidence,cycleId:started.cycle.id});
  requireValue(started.retryOf?.cycleId===parent.id && started.retryOf.revision===parent.revision &&
    /^[a-f0-9]{64}$/.test(started.retryOf.cycleSha256 || "") && /^[a-f0-9]{64}$/.test(started.retryOf.toolReceiptSha256 || "") &&
    typeof started.retryOf.toolExecutionId==="string" && started.retryOf.toolExecutionId.length>0,
    "The retry does not bind its exact failed parent and no-effect tool receipt");
  return verifiedMutationReceipt(started,started.cycle,evidence,"retry-setup","app.self_improvement.retry");
}
const terminalStages = ["failed", "cancelled", "no_change", "succeeded", "rolled_back"];
function retainedCycleSnapshot(cycle) {
  // These public fields are durable; UI eligibility can change with later policy
  // generations and must not be mistaken for a mutation of the terminal cycle.
  const {setupRetryAvailable:_retry,approvalExpired:_expired,approvalRenewalAvailable:_renew,
    discardAvailable:_discard,releaseEligibility:_eligibility,classification:_classification,...saved}=cycle;
  return saved;
}
function requireTrialPolicy(configuration, {dailyBudgetUsd, maxCycleBudgetUsd}) {
  sealed("policy",configuration.policy,"policySha256");
  requireValue(configuration.policy.dailyBudgetUsd===dailyBudgetUsd &&
    (configuration.policy.maxCycleBudgetUsd ?? dailyBudgetUsd)===maxCycleBudgetUsd &&
    configuration.policy.autoReleaseRoutineChanges===true && configuration.policy.notifyOutcomes===false,
    "The bounded trial policy changed");
}
function verifyNormalQueueAdmission(previous,parent,configuration) {
  const proof=previous.normalQueueFailure,admission=proof?.admissionResponse;
  requireValue(proof && admission && previous.dailyBudgetUsd===100 && previous.operationJob?.status==="failed" &&
    parent.stage==="failed" && parent.dailyReservationUsd===10 &&
    typeof proof.tenantId==="string" && proof.tenantId && typeof proof.ownerActorId==="string" && proof.ownerActorId &&
    parent.scope.tenantId===proof.tenantId && parent.scope.ownerActorId===proof.ownerActorId &&
    configuration.tenantId===proof.tenantId && configuration.ownerActorId===proof.ownerActorId,
    "The normal queue failure owner or configuration changed");
  const {serviceReceipt,...outcome}=admission;
  const {receiptSha256,...body}=serviceReceipt || {};
  requireValue(receiptSha256===probeSha256(body) && body.outcomeSha256===probeSha256(outcome) &&
    body.schemaVersion===1 && body.receiptKind==="app_service_receipt" && body.boundaryVersion==="p9.1-app-service-boundary:1" &&
    body.operation==="app.self_improvement.run" && body.accessMode==="mutation" && body.action==="manage.workflow" &&
    body.resourceType==="self_improvement" && body.eventContract==="self-improvement-events.v1" &&
    /^[a-f0-9]{64}$/.test(body.authoritySha256 || "") && /^[a-f0-9]{64}$/.test(proof.admissionIdempotencyKeySha256 || "") &&
    body.idempotencyKeySha256===proof.admissionIdempotencyKeySha256 && Number.isFinite(Date.parse(body.occurredAt)),
    "The normal owner admission receipt changed");
  const admitted=admission.cycle,job=admission.operationJob;
  requireValue(admission.outcome==="claimed" && admitted?.id===parent.id && admitted.configurationId===configuration.id &&
    admitted.projectId===parent.projectId && probeSha256(admitted.scope)===probeSha256(parent.scope) &&
    admitted.policy?.policySha256===previous.policySha256 && admitted.revision===1 && admitted.stage==="observing" &&
    admitted.spendUsd===0 && admitted.usageState==="known" && admitted.dailyReservationUsd===10 &&
    admitted.createdAt===parent.createdAt && job?.id===previous.operationJob.id && job.type===jobType && job.status==="queued",
    "The normal admission does not bind the exact cycle and original job");
  const settled=proof.settledUsage,runs=parent.agentRuns;
  requireValue(settled?.state==="known" && settled.spendUsd===parent.spendUsd && settled.unsettledPaidUsage===false &&
    Array.isArray(runs) && runs.length>0 && runs.every(run=>run.completed===true && typeof run.runId==="string") &&
    new Set(runs.map(run=>run.runId)).size===runs.length &&
    probeSha256(settled.completedRunIds)===probeSha256(runs.map(run=>run.runId)) &&
    /^[a-f0-9]{64}$/.test(proof.projectObjectiveSha256 || ""),
    "The normal failure does not retain settled usage and the saved brief");
}
async function readFailedNormalJob({json,previous,parent}) {
  const {job}=await json(`/api/operations/jobs/${previous.operationJob?.id}`);
  requireJobIdentity(job,previous);
  const snapshot={id:job.id,type:job.type,status:job.status,attempt:job.attempt,maxAttempts:job.maxAttempts,
    createdAt:job.createdAt,runAt:job.runAt,updatedAt:job.updatedAt,completedAt:job.completedAt,
    quarantined:job.quarantined===true,hasError:!!job.lastError};
  const times=[parent.createdAt,job.createdAt,previous.normalQueueFailure.admissionResponse.serviceReceipt.occurredAt,
    job.runAt,parent.updatedAt,job.completedAt,job.updatedAt].map(value=>Date.parse(value));
  requireValue(job.status==="failed" && job.attempt===1 && job.maxAttempts===1 && !snapshot.quarantined && snapshot.hasError &&
    times.every(Number.isFinite) && times[0]<=times[1] && times[1]<=times[2] && times[1]<=times[3] &&
    times[3]<=times[5] && times[2]<=times[4] && times[4]<=times[5] && times[5]<=times[6] &&
    (!job.result?.resourceId || job.result.resourceId===parent.id) &&
    probeSha256(snapshot)===probeSha256(previous.normalQueueFailure.terminalJob),
    "The normal queue job is not the exact completed failure");
  return snapshot;
}
function verifyStagedTerminalNoop(previous,parent,configuration) {
  const proof=previous.stagedTerminalNoop,settled=proof?.settledUsage,runs=parent.agentRuns;
  requireValue(proof && previous.artifactKind===undefined && previous.scenario==="self_improvement_v1" &&
    previous.status==="failed" && previous.exerciseStatus==="failed" && previous.signedOut===true && !previous.proof &&
    previous.executionMode==="staged_owner_advance" && previous.dailyAutonomyProven===false &&
    previous.configurationPaused===true && previous.dailyBudgetUsd===100 && previous.operationJob?.status==="queued" &&
    previous.stagedPendingJob?.id===previous.operationJob.id && previous.stagedPendingJob.type===jobType &&
    previous.stagedPendingJob.status==="queued" && previous.stagedPendingJob.attempt===0 && previous.stagedPendingJob.maxAttempts===1 &&
    /^[a-f0-9]{64}$/.test(proof.originalEvidenceSha256 || "") && /^[a-f0-9]{64}$/.test(proof.projectObjectiveSha256 || "") &&
    parent.stage==="failed" && parent.dailyReservationUsd===10 && parent.usageState==="known" &&
    typeof proof.tenantId==="string" && proof.tenantId && typeof proof.ownerActorId==="string" && proof.ownerActorId &&
    parent.scope.tenantId===proof.tenantId && parent.scope.ownerActorId===proof.ownerActorId &&
    configuration.tenantId===proof.tenantId && configuration.ownerActorId===proof.ownerActorId &&
    settled?.state==="known" && settled.spendUsd===parent.spendUsd && settled.unsettledPaidUsage===false &&
    Array.isArray(runs) && runs.length>0 && runs.every(run=>run.completed===true && typeof run.runId==="string") &&
    new Set(runs.map(run=>run.runId)).size===runs.length &&
    probeSha256(settled.completedRunIds)===probeSha256(runs.map(run=>run.runId)),
    "The staged terminal no-op does not retain its exact origin and settled usage");
}
async function readCompletedStagedJob({json,previous,parent}) {
  const {job}=await json(`/api/operations/jobs/${previous.operationJob?.id}`);
  requireJobIdentity(job,previous);
  const snapshot={id:job.id,type:job.type,status:job.status,attempt:job.attempt,maxAttempts:job.maxAttempts,
    createdAt:job.createdAt,runAt:job.runAt,updatedAt:job.updatedAt,completedAt:job.completedAt,
    quarantined:job.quarantined===true,hasError:!!job.lastError,progress:job.progress,result:job.result};
  const times=[parent.createdAt,job.createdAt,parent.updatedAt,job.progress?.completedAt,job.completedAt,job.updatedAt,job.runAt].map(value=>Date.parse(value));
  // Completion clears the lease and replaces progress.startedAt. Do not invent
  // an execution-start time: the exact failed result is the worker's terminal
  // early return, before configuration, lease, tools, or paid phase execution.
  requireValue(job.status==="completed" && job.attempt===1 && !snapshot.quarantined && !snapshot.hasError &&
    times.every(Number.isFinite) && times[0]<=times[1] && times[1]<=times[2] && times[2]<times[3] &&
    times[3]<=times[4] && times[4]<=times[5] && times[1]<=times[6] && times[6]<=times[4] &&
    probeSha256(job.progress)===probeSha256({stage:"completed",completedAt:job.progress.completedAt}) &&
    probeSha256(job.result)===probeSha256({resourceId:parent.id,stage:"failed"}) &&
    probeSha256(snapshot)===probeSha256(previous.stagedTerminalNoop.terminalJob),
    "The staged queue job is not the exact completed terminal no-op");
  return snapshot;
}
async function admitRetainedTrial({json,evidence,save,retainedEvidence,before}) {
  const previous=retainedEvidence.evidence;
  const normalFailure=previous?.artifactKind==="owner_normal_cycle_failure";
  const completedStaged=previous?.stagedTerminalNoop!==undefined;
  requireValue(/^[a-f0-9]{64}$/.test(retainedEvidence.sha256 || "") &&
    !(normalFailure && completedStaged) &&
    (normalFailure ? !("scenario" in previous) && !("exerciseStatus" in previous) && !("status" in previous)
      : previous?.scenario==="self_improvement_v1" && previous.exerciseStatus==="failed" && previous.status==="failed") &&
    previous.signedOut===true && !previous.proof &&
    previous.ownerHash===evidence.ownerHash && /^[a-f0-9]{40}$/.test(previous.revision || "") &&
    previous.revision!==evidence.revision && previous.maxCostUsd===10,
    "The retained trial is not an exact owner-bound failed verification");
  const parent=before.cycles.find(item=>item.id===previous.cycleId);
  let configuration=before.configurations.find(item=>item.id===previous.configurationId);
  requireValue(parent && configuration && parent.configurationId===configuration.id && parent.projectId===previous.projectId &&
    configuration.projectId===previous.projectId && configuration.repositoryId==="1260961340" &&
    parent.scope?.baseRevision===previous.revision && parent.policy?.policySha256===previous.policySha256 &&
    configuration.policy?.policySha256===previous.policySha256 && ["failed","no_change","cancelled"].includes(parent.stage) &&
    parent.usageState==="known" && Number.isFinite(parent.spendUsd) && parent.spendUsd>=0 && parent.spendUsd<=10 &&
    !parent.candidate && !parent.release && !parent.releaseReceipt && !parent.controllerHold &&
    previous.lastCycle?.id===parent.id && previous.lastCycle.revision===parent.revision &&
    previous.lastCycle.stage===parent.stage && previous.lastCycle.spendUsd===parent.spendUsd,
    "The retained trial is not terminal, reconciled, and unchanged");
  requireValue(before.cycles.every(item=>terminalStages.includes(item.stage)),"An active retained cycle cannot be replaced");
  requireTrialPolicy(configuration,{dailyBudgetUsd:previous.dailyBudgetUsd || 10,maxCycleBudgetUsd:10});
  requireValue(configuration.timeZone==="Asia/Kolkata" && configuration.dailyHour===3,"The retained trial schedule changed");
  if(normalFailure)verifyNormalQueueAdmission(previous,parent,configuration);
  if(completedStaged)verifyStagedTerminalNoop(previous,parent,configuration);
  const {project}=await json(`/api/projects/${previous.projectId}`);
  requireValue(project?.id===previous.projectId && project.status==="active","The retained engineering project changed");
  if(normalFailure)requireValue(probeSha256(project.objective)===previous.normalQueueFailure.projectObjectiveSha256,
    "The saved normal-cycle acceptance brief changed");
  if(completedStaged)requireValue(probeSha256(project.objective)===previous.stagedTerminalNoop.projectObjectiveSha256,
    "The saved staged-cycle acceptance brief changed");
  const retainedJob=normalFailure ? await readFailedNormalJob({json,previous,parent}) : completedStaged
    ? await readCompletedStagedJob({json,previous,parent}) : await readPendingJob({json,evidence:previous});
  evidence.projectId=previous.projectId;evidence.configurationId=configuration.id;evidence.dailyBudgetUsd=100;
  evidence.continuation={previousEvidenceSha256:retainedEvidence.sha256,previousCycleId:parent.id,
    previousCycleSha256:probeSha256(retainedCycleSnapshot(parent)),previousConfiguration:configuration,
    retainedJob,projectSha256:probeSha256(project),mutations:[],...(normalFailure?{normalQueueFailure:previous}:{}),
    // Retain the complete prior staged receipt, including any earlier normal
    // failure ancestry, rather than replacing it with a fabricated queue state.
    ...(completedStaged?{stagedTerminalNoop:previous,stagedTerminalNoopSha256:probeSha256(previous)}:{})};await save();
  const mutate=async(action,input,step,operation)=>{
    const attempt={action,input,step,status:"started"};evidence.continuation.mutations.push(attempt);await save();
    try {
      const response=await json("/api/self-improvement",{action,input},step);
      attempt.serviceReceipt=verifiedMutationReceipt(response,parent,evidence,step,operation);
      attempt.response=response;attempt.status="completed";await save();return response;
    } catch(error) {attempt.status="unconfirmed";await save();throw error;}
  };
  // A normal owner configuration and run partition the already authorized daily
  // budget. No terminal cycle, reservation, clock, or failure outcome is reset.
  const configured=await mutate("configure",{projectId:configuration.projectId,repositoryId:configuration.repositoryId,
    dailyBudgetUsd:100,maxCycleBudgetUsd:10,autoReleaseRoutineChanges:true,notifyOutcomes:false,
    timeZone:configuration.timeZone,dailyHour:configuration.dailyHour,expectedGeneration:configuration.generation},
  "configure-bounded-trial","app.self_improvement.configure");
  const next=configured.configuration;
  requireValue(next?.id===configuration.id && next.projectId===configuration.projectId && next.repositoryId===configuration.repositoryId &&
    probeSha256(next.repository)===probeSha256(configuration.repository) && next.generation===configuration.generation+1 &&
    next.paused===configuration.paused && next.nextDueAt===configuration.nextDueAt &&
    next.timeZone===configuration.timeZone && next.dailyHour===configuration.dailyHour,"The retained trial configuration changed scope or cadence");
  requireTrialPolicy(next,{dailyBudgetUsd:100,maxCycleBudgetUsd:10});configuration=next;
  evidence.policySha256=configuration.policy.policySha256;evidence.configurationGeneration=configuration.generation;await save();
  if(configuration.paused) {
    const resumed=await mutate("pause",{configurationId:configuration.id,expectedGeneration:configuration.generation,paused:false},
      "resume-bounded-trial","app.self_improvement.pause");
    requireValue(resumed.configuration?.id===configuration.id && resumed.configuration.generation===configuration.generation+1 &&
      !resumed.configuration.paused && resumed.configuration.policy.policySha256===evidence.policySha256 &&
      resumed.configuration.nextDueAt===configuration.nextDueAt,"The retained trial did not resume exactly");
    configuration=resumed.configuration;evidence.configurationGeneration=configuration.generation;await save();
  }
  const started=await mutate("run",{configurationId:configuration.id,expectedGeneration:configuration.generation},
    "run-bounded-trial","app.self_improvement.run");
  requireValue(started.outcome==="claimed" && started.cycle?.id!==parent.id,"The bounded owner run did not admit a fresh cycle");
  requireCycleScope(started.cycle,{...evidence,cycleId:started.cycle?.id});
  requireValue(started.cycle.dailyReservationUsd===10,"The new cycle did not retain its $10 ceiling");
  return started;
}
export async function admitImprovement({json,evidence,save,retryEvidence,retainedEvidence}) {
  const before=await json("/api/self-improvement");
  requireValue(before.github?.configured === true, "Hosted GitHub App is unavailable");
  requireValue(!(retryEvidence && retainedEvidence),"Select one explicit retained verification mode");
  if(retainedEvidence)return admitRetainedTrial({json,evidence,save,retainedEvidence,before});
  if(retryEvidence) {
    const previous=retryEvidence.evidence;
    requireValue(/^[a-f0-9]{64}$/.test(retryEvidence.sha256 || "") && previous?.scenario==="self_improvement_v1" &&
      previous.exerciseStatus==="failed" && previous.status==="failed" && previous.signedOut===true && !previous.proof &&
      !previous.retry && previous.ownerHash===evidence.ownerHash && /^[a-f0-9]{40}$/.test(previous.revision || "") &&
      previous.revision!==evidence.revision && previous.maxCostUsd===10,
      "The retained failure is not an exact owner-bound initial trial");
    const parent=before.cycles.find(item=>item.id===previous.cycleId);
    let configuration=before.configurations.find(item=>item.id===previous.configurationId);
    requireValue(parent && configuration && parent.configurationId===configuration.id && parent.projectId===previous.projectId &&
      configuration.projectId===previous.projectId && configuration.repositoryId==="1260961340" &&
      parent.scope?.baseRevision===previous.revision && parent.policy?.policySha256===previous.policySha256 &&
      configuration.policy?.policySha256===previous.policySha256 && parent.stage==="failed" && parent.usageState==="known" &&
      parent.spendUsd===0 && parent.phase==="setup" && parent.setupRetryAvailable===true && !parent.builderSessionId && !parent.candidate && !parent.release &&
      !parent.releaseReceipt && !parent.agentRuns?.length && Number.isSafeInteger(parent.revision),
      "The retained cycle does not prove a settled pre-AI setup failure");
    requireValue(before.cycles.every(item=>item.configurationId!==configuration.id ||
      ["failed","cancelled","no_change","succeeded","rolled_back"].includes(item.stage)),
      "An active retained cycle cannot be replaced");
    sealed("policy",configuration.policy,"policySha256");
    requireValue(configuration.policy.dailyBudgetUsd===10 && configuration.policy.autoReleaseRoutineChanges===true &&
      configuration.policy.notifyOutcomes===false,"The retained trial policy changed");
    const {project}=await json(`/api/projects/${previous.projectId}`);
    requireValue(project?.id===previous.projectId && project.status==="active","The retained engineering project changed");
    const pending=await readPendingJob({json,evidence:previous});
    evidence.projectId=previous.projectId;evidence.configurationId=configuration.id;evidence.policySha256=previous.policySha256;
    evidence.retry={previousEvidenceSha256:retryEvidence.sha256,failedCycleId:parent.id,failedCycleRevision:parent.revision,
      previousBaseRevision:previous.revision,retainedJob:pending};await save();
    if(configuration.paused) {
      const resumed=await json("/api/self-improvement",{action:"pause",input:{configurationId:configuration.id,
        expectedGeneration:configuration.generation,paused:false}},`resume-${configuration.generation}`);
      requireValue(resumed.configuration?.id===configuration.id && resumed.configuration.projectId===previous.projectId &&
        resumed.configuration.generation===configuration.generation+1 && !resumed.configuration.paused &&
        resumed.configuration.policy.policySha256===previous.policySha256,"The retained policy did not resume exactly");
      configuration=resumed.configuration;
    }
    evidence.configurationGeneration=configuration.generation;await save();
    // The server independently proves the pre-effect failure and admits at most
    // one child. The failed cycle and its original reservation remain immutable.
    const started=await json("/api/self-improvement",{action:"retry",input:{configurationId:configuration.id,
      expectedGeneration:configuration.generation,failedCycleId:parent.id,expectedRevision:parent.revision}},"retry-setup");
    evidence.retry.admissionReceipt=verifiedRetryAdmission(started,parent,evidence);
    evidence.retry.admissionResponse=started;
    evidence.retry.lineage=started.retryOf;
    await save();return started;
  }
  requireValue(!before.configurations.some(item => item.repositoryId === "1260961340"), "An existing repository policy requires explicit reconciliation; the probe will not replace it");
  const {project}=await json("/api/projects",{title:`Asael improvement verification ${evidence.marker.slice(0,8)}`,
    objective:"Investigate and repair an observed Visual Studio duplication defect. In src/components/studio/state.ts, duplicateGraphNodes appears to check the node limit but can copy connections beyond the graph limit. A valid graph with nine reference asset nodes, nine output gallery nodes and all 81 image-to-media connections becomes 36 nodes and 162 connections after duplicating every node; graph validation then rejects saving with invalid_graph. Independently inspect and reproduce this behavior before changing the implementation. Expected behavior: refuse an over-limit duplication before mutating history, explain the connection limit clearly, and allow a result with exactly 160 connections. Add a focused reproduction in src/components/studio/duplicate-connection-limit.test.ts; inspect src/components/studio/state.test.ts and src/lib/studio/graph.test.ts for adjacent regression coverage. Atlas plans, Forge reproduces and repairs, and Sentinel independently reviews real execution receipts. Keep all changes in the proposed candidate; this verification does not approve, merge or deploy it.",status:"active"},"project");
  requireValue(project?.id,"The synthetic project has no durable identity");evidence.projectId=project.id;await save();
  const {configuration}=await json("/api/self-improvement",{action:"configure",input:{projectId:project.id,repositoryId:"1260961340",dailyBudgetUsd:10,
    autoReleaseRoutineChanges:true,notifyOutcomes:false,timeZone:"Asia/Kolkata",dailyHour:3}},"configure");
  requireValue(configuration?.id && configuration.projectId === project.id && configuration.generation === 1 && !configuration.paused && configuration.policy.notifyOutcomes === false,
    "The synthetic improvement configuration is not isolated");
  evidence.configurationId=configuration.id;evidence.configurationGeneration=configuration.generation;evidence.policySha256=configuration.policy.policySha256;await save();
  return json("/api/self-improvement",{action:"run",input:{configurationId:configuration.id,expectedGeneration:configuration.generation}},"run");
}
export async function exerciseImprovement({json,evidence,save,sleep,now=Date.now,retryEvidence,retainedEvidence}) {
  const started=await admitImprovement({json,evidence,save,retryEvidence,retainedEvidence});
  requireValue(started.outcome==="claimed" && started.cycle?.id,"The queued improvement cycle was not newly admitted");
  evidence.cycleId=started.cycle.id;evidence.operationJob=started.operationJob;await save();
  evidence.stagedPendingJob=await readPendingJob({json,evidence});
  const deadline=now()+45*60_000;
  evidence.executionMode="staged_owner_advance";
  evidence.dailyAutonomyProven=false;
  evidence.advances=[];
  evidence.observations=[];
  evidence.pollCount=0;
  while(now()<deadline) {
    const state=await json("/api/self-improvement",undefined,undefined,{timeoutMs:Math.max(1,deadline-now())}),
      cycle=state.cycles.find(item=>item.id===evidence.cycleId);
    requireCycleScope(cycle,evidence);
    const previous=evidence.lastCycle;
    requireValue((!previous || cycle.revision>=previous.revision) && cycle.revision>=(evidence.advances.at(-1)?.resultRevision || 0),
      "The staged cycle revision moved backwards");
    const observedAt=new Date(now()).toISOString();
    evidence.lastCycle={id:cycle.id,revision:cycle.revision,stage:cycle.stage,phase:cycle.phase,spendUsd:cycle.spendUsd,usageState:cycle.usageState};
    evidence.lastObservedAt=observedAt;
    evidence.pollCount++;
    if(!previous || previous.revision!==cycle.revision || previous.stage!==cycle.stage || previous.phase!==cycle.phase) {
      evidence.observations.push({...evidence.lastCycle,observedAt});
    }
    await save();
    if(["review_required","ready_for_release","no_change","failed","cancelled","succeeded","rolled_back"].includes(cycle.stage)) {
      const proof=verifiedImprovementCycle(cycle,evidence);
      requireValue(evidence.advances.length>0,"The staged cycle has no owner-advance execution evidence");
      evidence.stagedPendingJob=await readPendingJob({json,evidence});
      evidence.proof=proof;await save();return;
    }
    requireValue(codingStages.includes(cycle.stage),"Unexpected staged improvement state");
    const leaseExpiresAt=Date.parse(cycle.executionLeaseExpiresAt);
    requireValue(Number.isFinite(leaseExpiresAt),"The staged cycle has no bounded execution lease");
    if(leaseExpiresAt>now()) {await sleep(Math.min(15_000,Math.max(0,deadline-now())));continue;}
    requireValue(evidence.advances.length<maxAdvances,`The staged cycle exceeded ${maxAdvances} bounded owner advances; it will not be repeated automatically`);
    requireValue(!evidence.advances.some(item=>item.expectedRevision===cycle.revision),"An owner advance cannot be repeated for the same revision");
    requireValue(deadline-now()>=advanceTimeoutMs,"Insufficient time remains for another bounded owner advance; it will not be repeated automatically");
    const step=`advance-${cycle.revision}`, attempt={expectedRevision:cycle.revision,phase:cycle.phase,startedAt:new Date(now()).toISOString(),status:"started"};
    evidence.advances.push(attempt);await save();
    try {
      // This authenticated route executes the same application-owned phase handler
      // as the held queue. It neither leases nor consumes the retained queue job.
      const result=await json("/api/self-improvement",{action:"advance",input:{cycleId:cycle.id,expectedRevision:cycle.revision}},step,{timeoutMs:advanceTimeoutMs});
      requireCycleScope(result.cycle,evidence);
      requireValue(result.cycle.revision>cycle.revision,"The owner advance made no durable revision progress");
      attempt.serviceReceipt=verifiedAdvanceReceipt(result,cycle,evidence,step);
      attempt.resultRevision=result.cycle.revision;attempt.status="completed";attempt.completedAt=new Date(now()).toISOString();await save();
    } catch(error) {attempt.status="unconfirmed";await save();throw error;}
  }
  throw new Error("The staged Asael cycle did not produce a reviewed repair within 45 minutes; it will not be repeated automatically");
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
async function readRetainedRepair({json,evidence}) {
  requireValue(evidence.exerciseStatus==="passed" && evidence.proof,"Staged repair evidence is not complete");
  requireValue(evidence.executionMode==="staged_owner_advance" && evidence.dailyAutonomyProven===false &&
    Array.isArray(evidence.observations) && evidence.observations.length>0 && Array.isArray(evidence.advances) &&
    evidence.advances.length>0 && evidence.advances.length<=maxAdvances,"Staged evidence does not identify bounded owner-advanced work");
  const revisions=new Set();let previous=0;
  for(const attempt of evidence.advances) {
    const {receiptSha256,...body}=attempt.serviceReceipt || {};
    requireValue(attempt.status==="completed" && Number.isSafeInteger(attempt.expectedRevision) && attempt.expectedRevision>=previous &&
      !revisions.has(attempt.expectedRevision) && Number.isSafeInteger(attempt.resultRevision) && attempt.resultRevision>attempt.expectedRevision &&
      body.operation==="app.self_improvement.advance" && receiptSha256===probeSha256(body),"The staged owner-advance receipts are incomplete or changed");
    revisions.add(attempt.expectedRevision);previous=attempt.resultRevision;
  }
  const state=await json("/api/self-improvement");
  if(evidence.continuation) {
    const retained=evidence.continuation,parent=state.cycles.find(item=>item.id===retained.previousCycleId);
    requireValue(!(retained.normalQueueFailure && retained.stagedTerminalNoop),"The retained continuation modes conflict");
    requireValue(parent && /^[a-f0-9]{64}$/.test(retained.previousEvidenceSha256 || "") &&
      probeSha256(retainedCycleSnapshot(parent))===retained.previousCycleSha256,"The retained terminal cycle changed");
    if(retained.normalQueueFailure) {
      const previous=retained.normalQueueFailure,configuration=state.configurations.find(item=>item.id===previous.configurationId);
      requireValue(previous.artifactKind==="owner_normal_cycle_failure" && previous.ownerHash===evidence.ownerHash &&
        previous.cycleId===parent.id && configuration,"The retained normal-cycle origin changed");
      verifyNormalQueueAdmission(previous,parent,configuration);
      requireValue(probeSha256(await readFailedNormalJob({json,previous,parent}))===probeSha256(retained.retainedJob),
        "The retained failed normal job changed after staging");
    }
    if(retained.stagedTerminalNoop) {
      const previous=retained.stagedTerminalNoop,configuration=state.configurations.find(item=>item.id===previous.configurationId);
      requireValue(previous.ownerHash===evidence.ownerHash && previous.cycleId===parent.id && configuration,
        "The retained staged terminal origin changed");
      requireValue(probeSha256(previous)===retained.stagedTerminalNoopSha256,"The retained staged failure ancestry changed");
      verifyStagedTerminalNoop(previous,parent,configuration);
      const {project}=await json(`/api/projects/${previous.projectId}`);
      requireValue(project?.id===previous.projectId && project.status==="active" &&
        probeSha256(project.objective)===previous.stagedTerminalNoop.projectObjectiveSha256,
        "The saved staged-cycle acceptance brief changed after staging");
      requireValue(probeSha256(await readCompletedStagedJob({json,previous,parent}))===probeSha256(retained.retainedJob),
        "The retained staged terminal no-op changed after staging");
    }
    requireValue(evidence.dailyBudgetUsd===100 && retained.mutations?.length>=2 && retained.mutations.length<=3 &&
      retained.mutations[0].action==="configure" && retained.mutations.at(-1).action==="run","The bounded admission history changed");
    for(const attempt of retained.mutations) {
      requireValue(attempt.status==="completed" && ["configure","pause","run"].includes(attempt.action),"The bounded admission has an uncertain mutation");
      const receipt=verifiedMutationReceipt(attempt.response,parent,evidence,attempt.step,`app.self_improvement.${attempt.action}`);
      requireValue(probeSha256(receipt)===probeSha256(attempt.serviceReceipt),"The bounded admission receipt changed");
    }
    const started=retained.mutations.at(-1).response;
    requireCycleScope(started.cycle,evidence);
    requireValue(started.outcome==="claimed" && started.cycle.dailyReservationUsd===10 &&
      probeSha256(started.operationJob)===probeSha256(evidence.operationJob),"The bounded run admission changed");
  }
  if(evidence.retry) {
    const parent=state.cycles.find(item=>item.id===evidence.retry.failedCycleId);
    requireValue(parent?.stage==="failed" && parent.revision===evidence.retry.failedCycleRevision &&
      parent.configurationId===evidence.configurationId && parent.projectId===evidence.projectId &&
      parent.policy?.policySha256===evidence.policySha256 && parent.scope?.baseRevision===evidence.retry.previousBaseRevision &&
      parent.spendUsd===0 && parent.usageState==="known","The retained failed parent changed");
    requireValue(/^[a-f0-9]{64}$/.test(evidence.retry.previousEvidenceSha256 || ""),"The failed trial evidence binding is missing");
    const receipt=verifiedRetryAdmission(evidence.retry.admissionResponse,parent,evidence);
    requireValue(probeSha256(receipt)===probeSha256(evidence.retry.admissionReceipt) &&
      probeSha256(evidence.retry.admissionResponse.retryOf)===probeSha256(evidence.retry.lineage),
      "The retained retry receipt or lineage changed");
  }
  requireValue(state.configurations.some(item=>item.id===evidence.configurationId && item.projectId===evidence.projectId && item.generation===evidence.configurationGeneration && !item.paused && item.policy.notifyOutcomes===false && item.policy.policySha256===evidence.policySha256),"The retained trial policy generation changed");
  const cycle=state.cycles.find(item=>item.id===evidence.cycleId);
  requireValue(probeSha256(verifiedImprovementCycle(cycle,evidence))===probeSha256(evidence.proof),"Canonical cycle differs from the exact staged repair");
}

export async function readbackImprovement({json,evidence,save=async()=>{},now=Date.now}) {
  await readRetainedRepair({json,evidence});
  evidence.canonicalPendingJob={...await readPendingJob({json,evidence}),observedAt:new Date(now()).toISOString()};await save();
}

export async function readbackImprovementQueue({json,evidence,save,sleep,activatedAt,now=Date.now}) {
  const activation=Date.parse(activatedAt);
  requireValue(evidence.canonicalReadback===true && evidence.canonicalPendingJob?.id===evidence.operationJob?.id &&
    Number.isFinite(activation) && activation>=Date.parse(evidence.canonicalPendingJob.observedAt) && activation<=now(),
    "Queue readback needs the canonical pending job and this release's activation timestamp");
  await readRetainedRepair({json,evidence});
  const deadline=now()+5*60_000;
  evidence.queueReadback={mode:"completed_cycle_noop",activatedAt,dailyAutonomyProven:false,status:"pending",observations:[]};await save();
  while(now()<deadline) {
    const {job}=await json(`/api/operations/jobs/${evidence.operationJob.id}`,undefined,undefined,{timeoutMs:Math.max(1,deadline-now())});
    requireJobIdentity(job,evidence);
    const observedAt=new Date(now()).toISOString();
    evidence.queueReadback.observations.push({status:job.status,attempt:job.attempt,observedAt});await save();
    requireValue(["queued","running","completed"].includes(job.status),"The retained improvement job failed after activation");
    if(job.status==="completed") {
      requireValue(job.attempt===1 && !job.lastError && Number.isFinite(Date.parse(job.completedAt)) &&
        Date.parse(job.completedAt)>=activation && Date.parse(job.completedAt)<=now() &&
        job.result?.resourceId===evidence.cycleId && job.result.stage===evidence.proof.stage && !job.result.__deferOperation,
        "The queue completion does not prove this cycle's post-activation no-op dispatch");
      await readRetainedRepair({json,evidence});
      evidence.queueReadback={...evidence.queueReadback,status:"passed",jobId:job.id,type:job.type,attempt:job.attempt,
        completedAt:job.completedAt,result:job.result,jobSha256:probeSha256(job)};await save();return;
    }
    requireValue((job.status==="queued" && job.attempt===0) || (job.status==="running" && job.attempt===1),"The retained queue attempt changed unexpectedly");
    await sleep(Math.min(15_000,Math.max(0,deadline-now())));
  }
  throw new Error("Canonical worker did not complete the retained no-op job within five minutes; unattended daily AI work remains unproven");
}
