import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { candidateBuildEnvironment, candidateBuildSandboxProfile } from "./build-isolation.mjs";

test("candidate environment does not inherit release secrets, Node injection, or credential HOME", () => {
  const env = candidateBuildEnvironment({ PATH: "/usr/bin", HOME: "/private-owner", DATABASE_URL: "secret", SMOKE_PAID_AGENT_PASSWORD: "secret", GH_TOKEN: "secret", NODE_OPTIONS: "--require malicious", npm_config_userconfig: "/owner/npmrc", HTTPS_PROXY: "secret" }, "/isolated");
  assert.equal(env.HOME, "/isolated");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=6144");
  for (const key of ["DATABASE_URL", "SMOKE_PAID_AGENT_PASSWORD", "GH_TOKEN", "HTTPS_PROXY"]) assert.equal(env[key], undefined);
});

test("macOS boundary denies credential files, dotenv, source writes and network", { skip: process.platform !== "darwin" }, async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "asael-build-boundary-")));
  try {
    const root = path.join(base, "candidate"), home = path.join(base, "build-home");
    await mkdir(root); await mkdir(home); await mkdir(path.join(root, ".next"));
    await writeFile(path.join(root, ".env.local"), "SECRET=fixture");
    await writeFile(path.join(root, "source.txt"), "fixture");
    const probe = path.join(root, "probe.cjs");
    await writeFile(probe, `const fs=require('fs');const net=require('net');let ok=0;for(const p of [${JSON.stringify(path.join(root, ".env.local"))},${JSON.stringify(path.join(base, "credential"))}]){try{fs.readFileSync(p);process.exit(20)}catch{ok++}}try{fs.writeFileSync(${JSON.stringify(path.join(root, "source.txt"))},'bad');process.exit(21)}catch{ok++}fs.writeFileSync(${JSON.stringify(path.join(root, ".next/output"))},'ok');const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(22));s.on('error',e=>process.exit(e.code==='EPERM'&&ok===3?0:23));setTimeout(()=>process.exit(24),2000);`);
    await writeFile(path.join(base, "credential"), "fixture");
    const profile = path.join(home, "build.sb");
    await writeFile(profile, candidateBuildSandboxProfile({ root, home, modules: root, executable: process.execPath, gitDirectory: path.join(root, ".git") }));
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, probe], { env: candidateBuildEnvironment(process.env, home), timeout: 10_000, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("isolated build can stop its own worker but cannot signal a host process", { skip: process.platform !== "darwin" }, async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "asael-build-signals-")));
  try {
    const root=path.join(base,"candidate"),home=path.join(base,"build-home");
    await mkdir(root);await mkdir(home);
    const probe=path.join(root,"probe.cjs"),profile=path.join(home,"build.sb");
    await writeFile(probe,`const {spawn}=require('child_process');try{process.kill(${process.pid},0);process.exit(20)}catch(e){if(e.code!=='EPERM')process.exit(21)}const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.on('spawn',()=>{try{child.kill('SIGTERM')}catch{process.exit(22)}});child.on('exit',(code,signal)=>process.exit(signal==='SIGTERM'?0:23));setTimeout(()=>process.exit(24),3000);`);
    await writeFile(profile,candidateBuildSandboxProfile({root,home,modules:root,executable:process.execPath,gitDirectory:path.join(root,".git")}));
    const result=spawnSync("/usr/bin/sandbox-exec",["-f",profile,process.execPath,probe],{env:candidateBuildEnvironment(process.env,home),timeout:10_000,encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
  } finally {await rm(base,{recursive:true,force:true});}
});
