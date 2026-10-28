/** Explicit offline replay of private, pinned capture files. No provider or network calls. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveOwnerRejectedEvidence } from "./probe-owner-rejected.mjs";
import { readImprovementReceipt, writeImprovementReceipt } from "./probe-receipt.mjs";
import { exerciseImprovement, readbackImprovement, readbackImprovementQueue, probeSha256 } from "./probe.mjs";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const seal=(kind,value,field)=>({...value,[field]:probeSha256({contract:"asael-self-improvement",version:1,kind,value})});
async function pinned(file,sha256) {
  const descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=await descriptor.stat();assert.ok(info.isFile() && info.uid===process.getuid() && !(info.mode&0o077) && info.size<2_000_000);
    const bytes=await descriptor.readFile();assert.equal(hash(bytes),sha256);return {bytes,sha256};
  } finally {await descriptor.close();}
}
const manifestFile=process.env.SELF_IMPROVEMENT_CAPTURED_MANIFEST;
test("pinned oversized capture survives lossless receipt conversion and all maintained probe phases offline",{skip:!manifestFile},async t=>{
  const manifest=JSON.parse(await readFile(manifestFile,"utf8")),sources={};
  for(const [kind,item] of Object.entries(manifest.sources))sources[kind]=await pinned(item.file,item.sha256);
  const initial=deriveOwnerRejectedEvidence(sources),origin=JSON.parse(sources.staged.bytes.toString("utf8"));
  assert.ok(sources.staged.bytes.length>=100_000,"This replay must include the actual oversized legacy capture");
  await assert.rejects(()=>readImprovementReceipt(manifest.sources.staged.file),/byte bound/);
  const directory=await mkdtemp(path.join(os.tmpdir(),"asael-captured-receipt-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const converted=path.join(directory,"captured.json"),priorFile=path.join(directory,"retained.json"),file=path.join(directory,"current.json");
  await writeImprovementReceipt(converted,origin,{create:true});assert.deepEqual(await readImprovementReceipt(converted),origin);
  await writeImprovementReceipt(priorFile,initial.evidence,{create:true});
  const retainedEvidence={evidence:await readImprovementReceipt(priorFile),sha256:hash(await readFile(priorFile))};
  let configuration=structuredClone(initial.configuration),current,clock=Date.parse("2026-10-29T10:00:00Z");
  let job={id:"22222222-2222-4222-8222-222222222222",type:"self_improvement.cycle.tick",status:"queued",attempt:0,maxAttempts:1};
  const evidence={scenario:"self_improvement_v1",revision:"e".repeat(40),ownerHash:origin.ownerHash,marker:"offline-captured-replay",
    status:"pending",maxCostUsd:10,resourcesRetained:true},calls=[];
  const mutation=(outcome,step,operation)=>{
    const body={schemaVersion:1,receiptKind:"app_service_receipt",boundaryVersion:"p9.1-app-service-boundary:1",operation,
      accessMode:"mutation",action:"manage.workflow",resourceType:"self_improvement",eventContract:"self-improvement-events.v1",
      authoritySha256:"d".repeat(64),idempotencyKeySha256:hash(`${initial.parent.scope.tenantId}\u0000improvement-smoke:${evidence.marker}:${step}`),
      outcomeSha256:probeSha256(outcome),occurredAt:new Date(clock).toISOString()};
    return {...outcome,serviceReceipt:{...body,receiptSha256:probeSha256(body)}};
  };
  const json=async(route,body,step)=>{
    calls.push({route,action:body?.action});
    if(!body) {
      if(route===`/api/projects/${initial.project.id}`)return {project:initial.project};
      if(route===`/api/operations/jobs/${initial.job.id}`)return {job:initial.job};
      if(route===`/api/operations/jobs/${job.id}`)return {job};
      assert.equal(route,"/api/self-improvement");
      return {github:{configured:true},configurations:[configuration],cycles:[initial.parent,...(current?[current]:[])]};
    }
    assert.equal(route,"/api/self-improvement");
    if(body.action==="configure") {
      assert.equal(body.input.expectedGeneration,configuration.generation);
      const {policySha256:_,...policy}=configuration.policy;
      configuration={...configuration,generation:configuration.generation+1,policy:seal("policy",{...policy,dailyBudgetUsd:100,maxCycleBudgetUsd:10},"policySha256")};
      return mutation({configuration},step,"app.self_improvement.configure");
    }
    if(body.action==="pause") {
      assert.equal(body.input.expectedGeneration,configuration.generation);assert.equal(body.input.paused,false);
      configuration={...configuration,generation:configuration.generation+1,paused:false};
      return mutation({configuration},step,"app.self_improvement.pause");
    }
    if(body.action==="run") {
      assert.equal(body.input.expectedGeneration,configuration.generation);
      current={...initial.parent,id:"offline-synthetic-child",stage:"observing",revision:1,phase:"setup",spendUsd:0,controllerHold:null,
        candidate:null,validation:null,scope:{...initial.parent.scope,baseRevision:evidence.revision},policy:configuration.policy,
        executionLeaseExpiresAt:new Date(0).toISOString()};
      return mutation({outcome:"claimed",cycle:current,operationJob:{id:job.id,type:job.type,status:job.status}},step,"app.self_improvement.run");
    }
    assert.equal(body.action,"advance");assert.equal(body.input.expectedRevision,1);
    const saved=await readImprovementReceipt(file);assert.equal(saved.advances.at(-1).status,"started");
    const candidate=initial.parent.candidate,{validationSha256:_,...validation}=initial.parent.validation;
    current={...current,revision:2,stage:"ready_for_release",phase:"release_wait",spendUsd:origin.proof.spendUsd,candidate,
      agentRuns:initial.evidence.ownerRejectedStage.settledUsage.agentRuns,
      validation:seal("validation",{...validation,scope:current.scope,policySha256:current.policy.policySha256,
        baselineReproduction:{...validation.baselineReproduction,revision:evidence.revision}},"validationSha256")};
    clock+=100;
    return mutation({cycle:current,phaseResult:{resourceId:current.id,stage:current.stage}},step,"app.self_improvement.advance");
  };
  await writeImprovementReceipt(file,evidence,{create:true});
  const save=()=>writeImprovementReceipt(file,evidence);
  await exerciseImprovement({json,evidence,save,retainedEvidence,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  evidence.exerciseStatus="passed";evidence.status="passed";await save();
  let currentEvidence=await readImprovementReceipt(file);
  const canonicalSave=()=>writeImprovementReceipt(file,currentEvidence),beforeReadbacks=calls.length;
  await readbackImprovement({json,evidence:currentEvidence,save:canonicalSave,now:()=>clock});
  currentEvidence.canonicalReadback=true;await canonicalSave();currentEvidence=await readImprovementReceipt(file);
  clock+=1000;job={...job,status:"completed",attempt:1,completedAt:new Date(clock).toISOString(),result:{resourceId:current.id,stage:current.stage}};
  await readbackImprovementQueue({json,evidence:currentEvidence,save:canonicalSave,now:()=>clock,sleep:async()=>{},activatedAt:new Date(clock).toISOString()});
  const complete=await readImprovementReceipt(file);assert.equal(complete.queueReadback.status,"passed");
  assert.ok(calls.slice(beforeReadbacks).every(call=>!call.action));
  assert.deepEqual(complete.continuation.ownerRejectedStage.continuation.stagedOrigin,origin);
  const originalAfter=await pinned(manifest.sources.staged.file,sources.staged.sha256);
  assert.deepEqual(originalAfter.bytes,sources.staged.bytes);
  const sizes={};for(const root of [converted,priorFile,file]) {
    sizes[path.basename(root)]=(await lstat(root)).size;
    for(const name of await readdir(`${root}.ancestry`))assert.ok((await lstat(path.join(`${root}.ancestry`,name))).size<100_000);
    assert.ok(sizes[path.basename(root)]<100_000);
  }
  // A copied current file without its bundle, or modified input ancestry, fails
  // before the app handler receives another configure/run/advance request.
  const copied=path.join(directory,"missing-ancestry.json");await writeFile(copied,await readFile(priorFile),{mode:0o600});
  await assert.rejects(()=>readImprovementReceipt(copied));
  const document=JSON.parse(await readFile(priorFile,"utf8")),ref=document.continuation.stagedOrigin.receiptReference;
  await writeFile(path.join(`${priorFile}.ancestry`,`${ref.sha256}.json`),"{}");
  await assert.rejects(()=>readImprovementReceipt(priorFile));
  const tampered={...sources,staged:{...sources.staged,bytes:Buffer.from("{}")}};
  assert.throws(()=>deriveOwnerRejectedEvidence(tampered),/Pinned staged/);
  const report={status:"passed",mode:"offline_pinned_capture_with_synthetic_fresh_child",networkCalls:0,modelCalls:0,
    originalBytes:sources.staged.bytes.length,originalSha256:sources.staged.sha256,originalPreserved:true,privateFileLimit:100_000,sizes,
    capturedParent:{cycleId:initial.parent.id,revision:initial.parent.revision,stage:initial.parent.stage,spendUsd:initial.parent.spendUsd,
      configurationGeneration:initial.configuration.generation,configurationPaused:initial.configuration.paused,
      paidPhases:initial.evidence.ownerRejectedStage.settledUsage.phases.length},
    maintainedPhases:["exercise","readback","queue_readback"],readbackMutations:0,syntheticActions:calls.filter(call=>call.action).map(call=>call.action),
    limits:["Fresh child/application responses are synthetic; this does not prove a new live repair or canonical promotion.",
      "Original captured stage remains passed and later owner rejection remains cancelled; no records were mutated."]};
  if(manifest.reportFile) {
    await mkdir(path.dirname(manifest.reportFile),{recursive:true,mode:0o700});
    const serialized=JSON.stringify(report,null,2)+"\n";
    try {await writeFile(manifest.reportFile,serialized,{mode:0o600,flag:"wx"});}
    catch(error) {if(error.code!=="EEXIST")throw error;assert.equal(await readFile(manifest.reportFile,"utf8"),serialized,"A retained replay report changed; select a new output instead of overwriting it");}
  }
  console.log(JSON.stringify(report));
});
