/** Offline derivation only. Never changes or relabels an original release receipt. */
import { createHash } from "node:crypto";
import { probeSha256 } from "./probe.mjs";

const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const sourceNames=["staged","diagnosis","holdRequest","holdResponse","rejectRequest","rejectResponse","finalState","project","logout"];

export function deriveOwnerRejectedEvidence(sources) {
  assert(Object.keys(sources).sort().join(",")===sourceNames.slice().sort().join(","),"Owner rejection source set changed");
  const parsed={},pins={};
  for(const name of sourceNames) {
    const {bytes,sha256}=sources[name] || {};
    // This explicit offline import is not the runtime receipt reader. It pins
    // the oversized original and the read-only SQL report before deriving a new
    // bounded receipt; normal release admission keeps its 100KB file boundary.
    assert(Buffer.isBuffer(bytes) && bytes.length<2_000_000 && /^[a-f0-9]{64}$/.test(sha256 || "") &&
      createHash("sha256").update(bytes).digest("hex")===sha256,`Pinned ${name} artifact changed`);
    parsed[name]=JSON.parse(bytes.toString("utf8"));pins[name]=sha256;
  }
  const origin=parsed.staged,diagnosis=parsed.diagnosis,cycle=diagnosis.cycle;
  const state=parsed.finalState.result,parent=state?.cycles?.find(item=>item.id===origin.cycleId),
    configuration=state?.configurations?.find(item=>item.id===origin.configurationId),project=parsed.project.result?.project;
  assert(parent && configuration && project?.id===origin.projectId && project.status==="active" && parsed.logout.result?.authenticated===false,
    "Owner rejection final state or logout is incomplete");
  assert(diagnosis.status==="passed" && diagnosis.productionMutations===false && diagnosis.workMutations===0 && diagnosis.modelCalls===0 &&
    diagnosis.credentialsPersisted===false && diagnosis.settledUsageProven===true && diagnosis.unsettledPaidUsage===false &&
    diagnosis.scope?.tenant===parent.scope.tenantId && diagnosis.scope.owner===parent.scope.ownerActorId &&
    diagnosis.scope.cycleId===parent.id && diagnosis.scope.projectId===parent.projectId && diagnosis.scope.configurationId===parent.configurationId &&
    diagnosis.scope.jobId===origin.operationJob?.id && cycle?.id===parent.id && cycle.configuration_id===parent.configurationId &&
    cycle.project_id===parent.projectId && cycle.base_revision===origin.revision && Number(cycle.revision)===origin.lastCycle?.revision &&
    cycle.stage===origin.proof?.stage && Number(cycle.spend_usd)===origin.proof.spendUsd && cycle.usage_state==="known" &&
    Number(cycle.reservation_usd)===10 && probeSha256(cycle.candidate)===probeSha256(parent.candidate) &&
    probeSha256(cycle.validation)===probeSha256(parent.validation),"Pinned diagnosis does not bind the staged candidate and settled usage");
  const agentRuns=diagnosis.fullRuntime?.value?.agentRuns,phases=diagnosis.phaseReservations;
  assert(Array.isArray(agentRuns) && Array.isArray(phases) && Array.isArray(diagnosis.runs) && diagnosis.runs.length===agentRuns.length &&
    diagnosis.runs.every(run=>run.status==="completed" && agentRuns.some(item=>item.runId===run.id && item.agentId===run.agent_id && item.completed===true) &&
      Number.isFinite(Date.parse(run.started_at)) && Date.parse(run.started_at)<=Date.parse(run.completed_at)),
    "Pinned diagnosis has incomplete paid agent runs");
  assert(diagnosis.jobs?.length===1,"Pinned diagnosis has an ambiguous operation job");
  const retained=diagnosis.jobs[0];
  assert(retained.owner_actor_id===parent.scope.ownerActorId && retained.cycle_id===parent.id && retained.id===origin.operationJob.id,
    "Pinned operation job owner or cycle changed");
  const job={id:retained.id,type:retained.type,status:retained.status,attempt:retained.attempt,maxAttempts:retained.max_attempts,
    createdAt:retained.created_at,runAt:retained.run_at,updatedAt:retained.updated_at,completedAt:retained.completed_at,
    quarantined:retained.quarantine!==null,lastError:retained.last_error,progress:retained.progress,result:retained.result};
  const {lastError,...terminalJob}=job;terminalJob.hasError=!!lastError;
  const request=parsed.rejectRequest;
  assert(request.method==="POST" && request.route==="/api/self-improvement" && typeof request.idempotencyKey==="string" && request.idempotencyKey &&
    parsed.holdRequest.method==="POST" && parsed.holdRequest.route==="/api/self-improvement/release-controller",
    "Pinned owner actions use an unexpected application boundary");
  const evidence={artifactKind:"owner_rejected_staged_candidate",revision:origin.revision,ownerHash:origin.ownerHash,maxCostUsd:10,dailyBudgetUsd:100,
    projectId:parent.projectId,configurationId:parent.configurationId,cycleId:parent.id,policySha256:origin.policySha256,
    signedOut:true,operationJob:origin.operationJob,lastCycle:{id:parent.id,revision:parent.revision,stage:parent.stage,
      spendUsd:parent.spendUsd,usageState:parent.usageState},continuation:{stagedOrigin:origin},
    ownerRejectedStage:{sources:pins,originalEvidenceSha256:pins.staged,originalValueSha256:probeSha256(origin),
      projectObjectiveSha256:probeSha256(project.objective),configuration,holdRequest:parsed.holdRequest.body,holdResponse:parsed.holdResponse.result,
      rejectRequest:request.body,rejectResponse:parsed.rejectResponse.result,
      rejectionIdempotencyKeySha256:createHash("sha256").update(`${parent.scope.tenantId}\u0000${request.idempotencyKey}`).digest("hex"),
      settledUsage:{state:"known",spendUsd:Number(cycle.spend_usd),unsettledPaidUsage:false,agentRuns,
        phases:phases.map(item=>({id:item.phase_id,reservedUsd:Number(item.reserved_usd),actualUsd:Number(item.actual_usd),state:item.state,
          createdAt:item.created_at,settledAt:item.settled_at,evidenceSha256:item.evidence_sha256}))},terminalJob}};
  return {evidence,parent,configuration,project,job};
}
