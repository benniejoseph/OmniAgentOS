import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IMPROVEMENT_RECEIPT_MAX_BYTES, readImprovementReceipt, writeImprovementReceipt } from "./probe-receipt.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = value => JSON.stringify(value, null, 2) + "\n";
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asael-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "current.json");
}
function ancestry(depth=4) {
  let value = { scenario:"self_improvement_v1", cycleId:"oldest", observations:[{note:"x".repeat(20_000)}] };
  for (let index=0; index<depth; index++) value = { scenario:"self_improvement_v1", cycleId:`cycle-${index}`,
    observations:[{note:"y".repeat(20_000)}], continuation:{ stagedTerminalNoop:value } };
  return value;
}
async function rootReference(file) {
  const document = JSON.parse(await readFile(file, "utf8"));
  const reference = document.continuation.stagedTerminalNoop.receiptReference;
  return {document,reference,member:path.join(`${file}.ancestry`,`${reference.sha256}.json`)};
}

test("bounded writer preserves complete ancestry while every persisted receipt stays private and below 100KB",async t=>{
  const file=await temporary(t), evidence=ancestry();
  assert.ok(Buffer.byteLength(bytes(evidence))>=IMPROVEMENT_RECEIPT_MAX_BYTES);
  await writeImprovementReceipt(file,evidence,{create:true});
  assert.deepEqual(await readImprovementReceipt(file),evidence);
  const members=await readdir(`${file}.ancestry`);
  assert.equal(members.length,4);
  for(const member of [file,...members.map(name=>path.join(`${file}.ancestry`,name))]) {
    const info=await lstat(member);assert.equal(info.mode&0o077,0);assert.ok(info.size<IMPROVEMENT_RECEIPT_MAX_BYTES);
  }
  assert.equal((await lstat(`${file}.ancestry`)).mode&0o077,0);
  const pinned=sha(await readFile(file));
  assert.deepEqual(await readImprovementReceipt(file,{expectedSha256:pinned}),evidence);
  await assert.rejects(()=>readImprovementReceipt(file,{expectedSha256:"0".repeat(64)}),/Pinned/);
  const originals=await Promise.all(members.map(async name=>[name,await readFile(path.join(`${file}.ancestry`,name))]));
  evidence.canonicalReadback=true;await writeImprovementReceipt(file,evidence);
  assert.deepEqual(await readdir(`${file}.ancestry`),members);
  for(const [name,original] of originals)assert.deepEqual(await readFile(path.join(`${file}.ancestry`,name)),original);
  assert.deepEqual(await readImprovementReceipt(file),evidence);
});
test("legacy private small receipts remain readable; oversized legacy input never admits paid work",async t=>{
  const file=await temporary(t),small=ancestry(0);
  await writeFile(file,bytes(small),{mode:0o600});assert.deepEqual(await readImprovementReceipt(file),small);
  await writeFile(file,bytes(ancestry()));
  await assert.rejects(()=>readImprovementReceipt(file),/byte bound/);
});
test("failed staged continuation retains its failed status and bounded immutable ancestry",async t=>{
  const file=await temporary(t),parent={status:"failed",stagedTerminalFailure:{terminalJob:{status:"failed"}},...ancestry()};
  const evidence={continuation:{stagedTerminalFailure:parent}};
  await writeImprovementReceipt(file,evidence,{create:true});
  const raw=await readFile(file,"utf8"),document=JSON.parse(raw);
  assert.ok(document.continuation.stagedTerminalFailure.receiptReference);
  assert.deepEqual(await readImprovementReceipt(file),evidence);
  const member=path.join(`${file}.ancestry`,`${document.continuation.stagedTerminalFailure.receiptReference.sha256}.json`);
  const before=await readFile(member);assert.equal(JSON.parse(before).status,"failed");
  evidence.canonicalReadback=true;await writeImprovementReceipt(file,evidence);
  assert.deepEqual(await readFile(member),before);
});
test("unbounded current proof fails before replacing the last readable receipt",async t=>{
  const file=await temporary(t),evidence=ancestry(1);await writeImprovementReceipt(file,evidence,{create:true});
  const original=await readFile(file);
  await assert.rejects(()=>writeImprovementReceipt(file,{...evidence,current:"x".repeat(100_000)}),/byte bound/);
  assert.deepEqual(await readFile(file),original);
  assert.deepEqual(await readImprovementReceipt(file),evidence);
  await assert.rejects(()=>writeImprovementReceipt(file,{different:true},{create:true}),/EEXIST/);
  assert.deepEqual(await readFile(file),original);
});
for(const [label,change] of [
  ["missing member",async({member})=>rm(member)],
  ["changed bytes",async({member})=>writeFile(member,'{"changed":true}\n')],
  ["oversized member",async({member})=>writeFile(member,"x".repeat(100_000))],
  ["public member",async({member})=>chmod(member,0o644)],
  ["member symlink",async({member})=>{const copy=`${member}.copy`;await writeFile(copy,"{}",{mode:0o600});await rm(member);await symlink(copy,member);}],
  ["public ancestry directory",async({file})=>chmod(`${file}.ancestry`,0o755)],
  ["arbitrary reference path",async({document,reference,file})=>{reference.path="../elsewhere";await writeFile(file,bytes(document));}],
  ["wrong reference length",async({document,reference,file})=>{reference.bytes++;await writeFile(file,bytes(document));}],
  ["changed value digest",async({document,reference,file})=>{reference.valueSha256="0".repeat(64);await writeFile(file,bytes(document));}],
  ["reference version",async({document,reference,file})=>{reference.version=2;await writeFile(file,bytes(document));}],
])test(`receipt readback fails closed on ${label}`,async t=>{
  const file=await temporary(t);await writeImprovementReceipt(file,ancestry(1),{create:true});
  await change({...await rootReference(file),file});
  await assert.rejects(()=>readImprovementReceipt(file));
});
test("writer cannot reuse a modified immutable member or follow a substituted ancestry directory",async t=>{
  const file=await temporary(t),evidence=ancestry(1);await writeImprovementReceipt(file,evidence,{create:true});
  const before=await readFile(file),{member}=await rootReference(file);
  await writeFile(member,"{}");await assert.rejects(()=>writeImprovementReceipt(file,evidence),/immutable/);
  assert.deepEqual(await readFile(file),before);
  await rm(`${file}.ancestry`,{recursive:true});
  await symlink(path.dirname(file),`${file}.ancestry`);
  await assert.rejects(()=>writeImprovementReceipt(file,evidence),/directory/);
  await assert.rejects(()=>readImprovementReceipt(file),/directory/);
});
test("private current receipt rejects symlinks and non-private permissions",async t=>{
  const file=await temporary(t);await writeImprovementReceipt(file,{ok:true},{create:true});
  await chmod(file,0o644);await assert.rejects(()=>readImprovementReceipt(file),/invalid/);
  await assert.rejects(()=>writeImprovementReceipt(file,{ok:true}),/ownership/);
  await rm(file);await symlink(path.join(path.dirname(file),"absent"),file);
  await assert.rejects(()=>readImprovementReceipt(file));
});
test("bounded traversal rejects deeply nested inline input and oversized expanded history",async t=>{
  const file=await temporary(t);
  let deep={value:true};for(let i=0;i<34;i++)deep={continuation:{stagedTerminalNoop:deep}};
  await writeFile(file,bytes(deep),{mode:0o600});await assert.rejects(()=>readImprovementReceipt(file),/document/);
  await assert.rejects(()=>writeImprovementReceipt(file,deep),/bound|document/);
  await assert.rejects(()=>writeImprovementReceipt(file,{value:"x".repeat(2_000_001)}),/materialized/);
  const broad={continuation:{stagedTerminalNoop:ancestry(16),normalQueueFailure:ancestry(16)}};
  await assert.rejects(()=>writeImprovementReceipt(file,broad),/traversal bound/);
});
test("aggregate bytes are bounded independently of per-file size and materialized JSON",async t=>{
  const file=await temporary(t),directory=`${file}.ancestry`;
  await mkdir(directory,{mode:0o700});
  let document={padding:Array(10_000).fill(0)},materialized=document,total=0;
  for(let index=0;index<30;index++) {
    const raw=Buffer.from(bytes(document)),digest=sha(raw);total+=raw.length;
    assert.ok(raw.length<100_000);
    await writeFile(path.join(directory,`${digest}.json`),raw,{mode:0o600});
    const reference={receiptReference:{version:1,sha256:digest,bytes:raw.length,valueSha256:sha(JSON.stringify(materialized))}};
    document={padding:Array(10_000).fill(0),continuation:{stagedTerminalNoop:reference}};
    materialized={padding:Array(10_000).fill(0),continuation:{stagedTerminalNoop:materialized}};
  }
  assert.ok(total>2_000_000);assert.ok(Buffer.byteLength(JSON.stringify(materialized))<2_000_000);
  await writeFile(file,bytes(document),{mode:0o600});
  await assert.rejects(()=>readImprovementReceipt(file),/aggregate byte bound/);
  await assert.rejects(()=>writeImprovementReceipt(file,materialized),/aggregate byte bound/);
});
