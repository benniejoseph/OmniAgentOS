import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStudioGenerationContract } from "./studio-readback-recovery.mjs";
const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const probeFailure = (pattern) => (error) => {
  assert.match(JSON.parse(error.stdout).failure, pattern);
  return true;
};

async function fixture(callback, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "asael-studio-probe-"));
  const media = [
    await readFile(
      new URL("../public/studio-demo/image-1.png", import.meta.url),
    ),
    await readFile(new URL("../public/studio-demo/video.mp4", import.meta.url)),
  ];
  let flow, run;
  const projects = new Map(), flows = new Map(), replays = new Map();
  const observed = {
    creates: 0,
    submissions: 0,
    advances: 0,
    mutations: [],
    wrongHash: false,
    actorId: "fixture@example.test",
    unsignedAdmission: false,
    requests: [],
    quotes: 0,
    projectCreates: 0,
  };
  const mode = options.mode || "demo";
  const provider = mode === "live" ? "google" : "demo";
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const value = raw ? JSON.parse(raw) : {};
      const url = request.url;
      const resource = new URL(url, "http://fixture");
      const key = request.headers["idempotency-key"];
      observed.requests.push({ method: request.method, url });
      let payload = {},
        status = 200;
      if (request.method !== "GET" && !url.startsWith("/api/auth/"))
        observed.mutations.push(url);
      if (url === "/api/health")
        payload = { status: "healthy", revision: options.revision || "candidate" };
      else if (url === "/api/auth/login") {
        response.setHeader("set-cookie", "session=fixture; HttpOnly");
        payload = {
          authenticated: true,
          context: {
            source: "session",
            tenantId: "fixture",
            actorId: observed.actorId,
            auth: { userId: "account-1" },
          },
        };
      } else if (url === "/api/auth/logout") payload = { authenticated: false };
      else if (url === "/api/studio/capabilities")
        payload = {
          capabilities: ["image-generate", "video-image"].map(
            (suffix, index) => ({
              id: `${provider}-${suffix}`,
              available: true,
              maxOutputs: mode === "demo" && index === 0 ? 3 : 1,
              model:
                mode === "demo"
                  ? "studio-fixture-v1"
                  : index === 0
                    ? "gemini-3.1-flash-image"
                    : "gemini-omni-1.1-flash",
            }),
          ),
        };
      else if (url === "/api/studio/projects") {
        if (request.method === "POST") {
          if (!replays.has(key)) {
            observed.projectCreates++;
            const id = `project-${observed.projectCreates}`;
            const project = { id, title: value.title, workspaceId: "workspace-1", status: "active", legacyProjectId: null,
              profile: { ...value.profile, projectId: id, revision: 1, updatedAt: "2026-10-26T00:00:00.000Z" } };
            projects.set(id, project);
            replays.set(key, { project });
          }
          payload = replays.get(key);
        } else payload = { projects: [...projects.values()] };
      } else if (/^\/api\/studio\/projects\/project-\d+\/profile$/.test(url)) {
        const id = url.split("/")[4];
        let project = projects.get(id);
        if (request.method === "PATCH") {
          if (replays.has(key)) payload = replays.get(key);
          else {
            assert.equal(value.revision, project.profile.revision);
            project = { ...project, profile: { ...value.profile, projectId: id,
              revision: value.revision + 1, updatedAt: "2026-10-26T00:01:00.000Z" } };
            projects.set(id, project);
            if (options.mutateRunOnProfilePatch) run.graph.projectContext.profileRevision = project.profile.revision;
            payload = { project, profile: project.profile };
            replays.set(key, payload);
          }
        } else payload = { project, profile: project.profile };
      } else if (url === "/api/studio/flows" && request.method === "POST") {
        observed.creates++;
        const created = { ...value, id: `flow-${observed.creates}`, revision: 1 };
        if (options.projects) {
          created.workspaceId = "workspace-1";
          created.graph = { ...value.graph, projectContext: contextFor(value.projectId) };
          if (options.wrongContext) created.graph.projectContext = contextFor("project-2");
        }
        flows.set(created.id, created);
        if (created.id === "flow-1") flow = created;
        payload = { flow: created };
      } else if (/^\/api\/studio\/flows\/flow-\d+\/actions$/.test(url)) {
        const id = url.split("/")[4], source = flows.get(id);
        if (replays.has(key) && !options.duplicateReplayMismatch) payload = replays.get(key);
        else {
          assert.equal(value.revision, source.revision);
          const result = structuredClone(source);
          if (value.action === "duplicate") {
            observed.creates++;
            result.id = `flow-${observed.creates}`;
            result.projectId = value.projectId;
            result.revision = 1;
            for (const node of result.graph.nodes) {
              delete node.config.selectedOutputId;
              if (!value.retainReferences) {
                delete node.config.assetId; delete node.config.assetVersion;
              }
            }
          } else {
            assert.equal(value.action, "apply-project-profile");
            result.revision++;
          }
          result.graph.projectContext = contextFor(result.projectId);
          flows.set(result.id, result);
          payload = { flow: result };
          replays.set(key, payload);
        }
      } else if (resource.pathname === "/api/studio/flows" && request.method === "GET") {
        payload = { flows: [...flows.values()].filter(item => item.projectId === resource.searchParams.get("projectId")) };
        if (options.mixedList) payload.flows.push([...flows.values()].find(item => item.projectId !== resource.searchParams.get("projectId")));
      } else if (/^\/api\/studio\/flows\/flow-\d+$/.test(url)) payload = { flow: flows.get(url.split("/")[4]) };
      else if (url === "/api/studio/flows/flow-1/quote") {
        observed.quotes++;
        payload = {
          quote: {
            id: "quote-1",
            generationCount: 2,
            reusedNodeIds: [],
            issues: [],
            requiresUnknownCostConsent: false,
            estimate: {
              status: mode === "demo" ? "known" : "range",
              maximumUsd: options.overBudget ? 4 : mode === "demo" ? 0 : 3.2768,
            },
          },
        };
      }
      else if (url === "/api/studio/flows/flow-1/runs") {
        observed.submissions++;
        assert.equal(value.maxCostUsd, options.projects ? 0 : 3.5);
        assert.equal(value.maxGenerations, 2);
        assert.equal(value.allowUnknownCost, false);
        assert.equal(
          flow.graph.nodes.filter((node) =>
            ["image", "video"].includes(node.type),
          ).length,
          2,
        );
        run = {
          id: "run-1",
          flowId: "flow-1",
          flowRevision: 1,
          graph: structuredClone(flow.graph),
          status: "queued",
          maxCostUsd: value.maxCostUsd,
          maxGenerations: 2,
          nodes: [],
        };
        payload = { run };
        if (options.ambiguousSubmission) {
          request.socket.destroy();
          return;
        }
      } else if (url === "/api/studio/runs/run-1") {
        if (request.method === "POST") {
          assert.equal(value.action, "advance");
          observed.advances++;
          run.status = options.uncertain ? "uncertain" : "succeeded";
          run.nodes = ["image", "video"].map((nodeId, index) => ({
            nodeId,
            status: "succeeded",
            ...(options.projects ? { effectivePrompt: effectivePrompt(nodeId) } : {}),
            attempts: [
              {
                id: `attempt-${index}`,
                providerRequestId: `provider-${index}`,
                status: "succeeded",
              },
            ],
            inputAssets: index === 1 ? [asset(0)] : [],
            outputAssets: [asset(index)],
          }));
          run.nodes.push({
            nodeId: "gallery",
            status: "succeeded",
            outputAssets: [asset(0), asset(1)],
          });
        }
        payload = { run };
      } else if (url.startsWith("/api/capture/assets/asset-")) {
        const index = Number(url.match(/asset-(\d)/)[1]);
        if (url.includes("content=1")) {
          response.writeHead(200, {
            "content-type": index ? "video/mp4" : "image/png",
          });
          response.end(
            observed.wrongHash ? Buffer.from("wrong") : media[index],
          );
          return;
        }
        payload = {
          asset: {
            ...asset(index),
            metadata: {
              studioRunId: "run-1",
              studioFlowId: "flow-1",
              studioNodeId: index ? "video" : "image",
              studioAttemptId: `attempt-${index}`,
              providerRequestId: `provider-${index}`,
              provider,
              model:
                mode === "demo"
                  ? "studio-fixture-v1"
                  : index
                    ? "gemini-omni-1.1-flash"
                    : "gemini-3.1-flash-image",
              studioDemo: mode === "demo",
              width: 960,
              height: 540,
              ...(index ? { durationSeconds: 3 } : {}),
            },
          },
        };
      } else {
        status = 404;
        payload = { error: "Unexpected fixture route" };
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  function contextFor(id) {
    const { revision, updatedAt: _at, ...profile } = projects.get(id).profile;
    return { ...profile, profileRevision: revision };
  }
  function effectivePrompt(id) {
    const { projectId: _id, profileRevision: _revision, ...context } = run.graph.projectContext;
    if (options.wrongPrompt) context.voice = "The wrong voice";
    const primary = run.graph.nodes.find(node => node.id === (id === "image" ? "prompt" : id)).config.prompt;
    const brand = `Project creative context (reference only):\n${JSON.stringify(context)}`;
    return `${primary}\n\n${brand}${options.duplicatePrompt ? `\n${brand}` : ""}`;
  }
  function asset(index) {
    return {
      id: `asset-${index}`,
      mediaType: index ? "video/mp4" : "image/png",
      contentSha256: hash(media[index]),
      byteCount: media[index].length,
    };
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "evidence.json");
  const env = {
    ...process.env,
    BASE_URL: `http://127.0.0.1:${server.address().port}`,
    EXPECTED_REVISION: options.revision || "candidate",
    SMOKE_STUDIO_ALLOW_LOOPBACK: "CONFIRMED",
    LIVE_VERIFY_STUDIO_FLOW: "CONFIRMED",
    SMOKE_STUDIO_FLOW_EVIDENCE_FILE: file,
    STUDIO_SMOKE_MODE: mode,
    SMOKE_STUDIO_PROJECTS: options.projects ? "CONFIRMED" : "",
    SMOKE_STUDIO_FLOW_MODE: "exercise",
    SMOKE_STUDIO_POLL_MS: "1",
    SMOKE_PAID_AGENT_EMAIL: "fixture@example.test",
    SMOKE_PAID_AGENT_PASSWORD: "fixture-password",
    SMOKE_INTERNAL_AUTH_SECRET: "fixture-secret",
  };
  const launch = (overrides = {}) =>
    exec(process.execPath, ["scripts/smoke-studio-flow.mjs"], {
      env: { ...env, ...overrides },
      timeout: 30_000,
    });
  try {
    await callback({ observed, file, launch, dir,
      editFlow: (edit) => { flow = edit(structuredClone(flow)); flows.set("flow-1", flow); },
      editRun: (edit) => { run = edit(structuredClone(run)); },
      editProject: (id, edit) => { projects.set(id, edit(structuredClone(projects.get(id)))); },
      editProjectFlow: (id, edit) => { flows.set(id, edit(structuredClone(flows.get(id)))); },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("Studio release exercise submits once, advances only its run, then reads identical assets", async () => {
  await fixture(async ({ observed, file, launch }) => {
    await launch();
    assert.equal(observed.submissions, 1);
    assert.equal(observed.creates, 1);
    assert.equal(observed.advances, 1);
    const count = observed.mutations.length;
    await launch({ SMOKE_STUDIO_FLOW_MODE: "readback" });
    const evidence = JSON.parse(await readFile(file, "utf8"));
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.canonicalReadback, true);
    assert.equal(evidence.signedOut, true);
    assert.equal(evidence.verifiedGenerationAttempts, 2);
    assert.equal(observed.mutations.length, count);
    await assert.rejects(launch());
    assert.equal(observed.submissions, 1);
    assert.equal(observed.creates, 1);
    assert.equal(JSON.parse(await readFile(file, "utf8")).status, "passed");
  });
});

test("Studio canonical verification catches changed bytes without rerunning generation", async () => {
  await fixture(async ({ observed, file, launch }) => {
    await launch();
    observed.wrongHash = true;
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback" }));
    const evidence = JSON.parse(await readFile(file, "utf8"));
    assert.equal(evidence.status, "failed");
    assert.match(evidence.failure, /byte\/hash/);
    assert.equal(observed.submissions, 1);
    assert.equal(observed.advances, 1);
    observed.wrongHash = false;
    await launch({ SMOKE_STUDIO_FLOW_MODE: "readback" });
    const recovered = JSON.parse(await readFile(file, "utf8"));
    assert.equal(recovered.status, "passed");
    assert.equal(recovered.canonicalReadback, true);
    assert.equal(recovered.failure, undefined);
    assert.equal(observed.submissions, 1);
  });
});

test("Studio canonical verification rejects another owner of the same tenant", async () => {
  await fixture(async ({ observed, launch }) => {
    await launch();
    observed.actorId = "other@example.test";
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback" }));
    assert.equal(observed.submissions, 1);
  });
});

test("Live Studio mode requires explicit paid admission and retains the reviewed bound", async () => {
  await fixture(
    async ({ observed, file, launch }) => {
      await assert.rejects(launch({ LIVE_VERIFY_STUDIO_GENERATION: "" }));
      assert.equal(observed.creates, 0);
      await launch({ LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" });
      const evidence = JSON.parse(await readFile(file, "utf8"));
      assert.equal(evidence.mode, "live");
      assert.equal(evidence.reservedApiCostUsd, 3.2768);
      assert.equal(evidence.maxCostUsd, 3.5);
      assert.equal(observed.submissions, 1);
    },
    { mode: "live" },
  );
});

test("Studio stops at an over-budget quote without a provider run", async () => {
  await fixture(
    async ({ observed, launch }) => {
      await assert.rejects(
        launch({ LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" }),
      );
      assert.equal(observed.submissions, 0);
      assert.equal(observed.advances, 0);
    },
    { mode: "live", overBudget: true },
  );
});

test("An ambiguous run-create response is never resubmitted", async () => {
  await fixture(
    async ({ observed, file, launch }) => {
      await assert.rejects(launch());
      await assert.rejects(launch());
      assert.equal(observed.submissions, 1);
      const evidence = JSON.parse(await readFile(file, "utf8"));
      assert.equal(evidence.status, "failed");
      assert.equal(evidence.flowId, "flow-1");
      assert.equal(evidence.runId, undefined);
    },
    { ambiguousSubmission: true },
  );
});

test("An uncertain provider attempt stops the exercise without regeneration", async () => {
  await fixture(
    async ({ observed, file, launch }) => {
      await assert.rejects(launch());
      assert.equal(observed.submissions, 1);
      assert.equal(observed.advances, 1);
      assert.equal(
        JSON.parse(await readFile(file, "utf8")).lastStatus,
        "uncertain",
      );
    },
    { uncertain: true },
  );
});

test("Studio readback accepts a viewport-only revision and retains the exact run revision", async () => {
  await fixture(async ({ observed, file, launch, editFlow, editRun }) => {
    await launch();
    editFlow((flow) => ({ ...flow, revision: 4, viewport: { x: 90, y: 30, zoom: 0.7 } }));
    await launch({ SMOKE_STUDIO_FLOW_MODE: "readback" });
    const evidence = JSON.parse(await readFile(file, "utf8"));
    assert.equal(evidence.observedFlowRevision, 4);
    assert.equal(evidence.flowRevision, 1);
    editRun((run) => ({ ...run, flowRevision: 4 }));
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback" }), probeFailure(/successful immutable quoted revision/));
    assert.equal(observed.submissions, 1);
    assert.equal(observed.advances, 1);
  });
});

test("Studio readback rejects changed graph, foreign flow ID and regressed flow revision", async () => {
  for (const change of [
    (flow) => ({ ...flow, revision: 2, graph: { ...flow.graph, schemaVersion: 2 } }),
    (flow) => ({ ...flow, id: "another-flow" }),
    (flow) => ({ ...flow, revision: 0 }),
  ]) await fixture(async ({ launch, editFlow }) => {
    await launch();
    editFlow(change);
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback" }), probeFailure(/Saved Studio flow changed/));
  });
});

async function withRecovery(callback) {
  const revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const contract = await getStudioGenerationContract(revision);
  await fixture(async (context) => {
    await context.launch({ LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" });
    const source = JSON.parse(await readFile(context.file, "utf8"));
    // The original exercise passed; the subsequent canonical false negative is retained.
    source.status = "failed";
    source.failure = "Saved Studio flow changed during verification";
    await writeFile(context.file, JSON.stringify(source));
    const original = await readFile(context.file);
    const pin = { version: 1, candidateRevision: revision, sourceRevision: revision,
      sourceEvidenceFile: context.file, sourceEvidenceSha256: hash(original), generationContractSha256: contract.sha256 };
    const output = path.join(context.dir, "recovered.json");
    const recoveryEnv = { OMNIAGENT_RELEASE_STUDIO_READBACK: JSON.stringify(pin),
      LIVE_VERIFY_STUDIO_GENERATION: "", SMOKE_STUDIO_FLOW_MODE: "readback",
      SMOKE_STUDIO_READBACK_STAGE: "staged", SMOKE_STUDIO_FLOW_EVIDENCE_FILE: output };
    await callback({ ...context, original, pin, output, recoveryEnv });
  }, { mode: "live", revision });
}

test("Hash-bound Studio recovery reads identical paid results at staging and canonical without mutation", async () => {
  await withRecovery(async ({ observed, file, original, output, launch, recoveryEnv, editFlow, pin }) => {
    const mutationCount = observed.mutations.length;
    editFlow((flow) => ({ ...flow, revision: 4 }));
    await launch(recoveryEnv);
    const staged = JSON.parse(await readFile(output, "utf8"));
    assert.equal(staged.stagedReadback, true);
    assert.equal(staged.canonicalReadback, false);
    assert.equal(staged.recovery.sourceEvidenceSha256, pin.sourceEvidenceSha256);
    assert.equal(staged.recovery.sourceStatus, "failed");
    assert.equal(staged.newGenerationAttempts, 0);
    await launch({ ...recoveryEnv, SMOKE_STUDIO_READBACK_STAGE: "canonical" });
    const canonical = JSON.parse(await readFile(output, "utf8"));
    assert.equal(canonical.status, "passed");
    assert.equal(canonical.canonicalReadback, true);
    assert.equal(canonical.signedOut, true);
    assert.deepEqual(canonical.assets, JSON.parse(original).assets);
    assert.deepEqual(await readFile(file), original);
    assert.equal(observed.mutations.length, mutationCount);
    assert.equal(observed.submissions, 1);
    assert.equal(observed.advances, 1);
    await assert.rejects(launch(recoveryEnv), probeFailure(/already exists/));
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "passed");
  });
});

test("Studio recovery fails before network for mismatched pins, mixed admission or source output reuse", async () => {
  await withRecovery(async ({ observed, file, original, launch, recoveryEnv, pin }) => {
    const requestCount = observed.requests.length;
    for (const override of [
      { LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" },
      { SMOKE_STUDIO_FLOW_MODE: "exercise" },
      { SMOKE_STUDIO_FLOW_EVIDENCE_FILE: file },
      { OMNIAGENT_RELEASE_STUDIO_READBACK: JSON.stringify({ ...pin, sourceEvidenceSha256: "0".repeat(64) }) },
      { OMNIAGENT_RELEASE_STUDIO_READBACK: JSON.stringify({ ...pin, sourceRevision: "a".repeat(40) }) },
      { OMNIAGENT_RELEASE_STUDIO_READBACK: JSON.stringify({ ...pin, generationContractSha256: "0".repeat(64) }) },
    ]) await assert.rejects(launch({ ...recoveryEnv, ...override }));
    assert.equal(observed.requests.length, requestCount);
    assert.deepEqual(await readFile(file), original);
  });
});

test("Studio recovery still rejects changed immutable run and asset bytes without another attempt", async () => {
  await withRecovery(async ({ observed, file, original, launch, output, recoveryEnv, editRun }) => {
    await launch(recoveryEnv);
    observed.wrongHash = true;
    await assert.rejects(launch({ ...recoveryEnv, SMOKE_STUDIO_READBACK_STAGE: "canonical" }), probeFailure(/byte\/hash/));
    observed.wrongHash = false;
    editRun((run) => ({ ...run, graph: { ...run.graph, schemaVersion: 2 } }));
    await assert.rejects(launch({ ...recoveryEnv, SMOKE_STUDIO_READBACK_STAGE: "canonical" }), probeFailure(/successful immutable quoted revision/));
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "failed");
    assert.deepEqual(await readFile(file), original);
    assert.equal(observed.submissions, 1);
    assert.equal(observed.advances, 1);
  });
});

test("Project release exercise keeps one zero-cost demo run and exact readback across two brands", async () => {
  await fixture(async ({ observed, file, launch }) => {
    await launch();
    const exercise = JSON.parse(await readFile(file, "utf8"));
    assert.equal(exercise.maxCostUsd, 0);
    assert.equal(exercise.reservedApiCostUsd, 0);
    assert.equal(exercise.projectProbe.status, "passed");
    assert.equal(exercise.projectProbe.projects[0].profile.revision, 2);
    assert.equal(exercise.projectProbe.mainContext.profileRevision, 1);
    assert.equal(exercise.projectProbe.flows.length, 4);
    assert.equal(exercise.projectProbe.referenceAsset.id, exercise.assets[0].id);
    assert.equal(observed.projectCreates, 2);
    assert.equal(observed.creates, 4);
    assert.equal(observed.quotes, 1);
    assert.equal(observed.submissions, 1);
    assert.equal(observed.advances, 1);
    const start = observed.requests.length, mutations = observed.mutations.length;
    await launch({ SMOKE_STUDIO_FLOW_MODE: "readback" });
    const canonical = JSON.parse(await readFile(file, "utf8"));
    assert.equal(canonical.canonicalReadback, true);
    assert.deepEqual(canonical.projectProbe, exercise.projectProbe);
    assert.equal(canonical.graphSha256, exercise.graphSha256);
    assert.deepEqual(canonical.assets, exercise.assets);
    assert.equal(observed.mutations.length, mutations);
    const readback = observed.requests.slice(start).filter(request => !request.url.startsWith("/api/auth/"));
    assert.ok(readback.every(request => request.method === "GET"));
    assert.ok(readback.every(request => !["/api/studio/projects", "/api/studio/flows", "/api/studio/capabilities"].includes(request.url)));
    await assert.rejects(launch(), probeFailure(/already exists/));
    assert.equal(observed.submissions, 1);
    assert.equal(observed.quotes, 1);
  }, { projects: true });
});

test("Project probe rejects incorrect inherited context before generation", async () => {
  await fixture(async ({ launch, observed }) => {
    await assert.rejects(launch(), probeFailure(/inherit the exact saved project profile/));
    assert.equal(observed.submissions, 0);
  }, { projects: true, wrongContext: true });
});

test("Project probe rejects wrong or repeated effective brand prompts without rerunning", async () => {
  for (const option of ["wrongPrompt", "duplicatePrompt"]) await fixture(async ({ launch, observed }) => {
    await assert.rejects(launch(), probeFailure(/wrong brand profile|context exactly once/));
    assert.equal(observed.submissions, 1);
    assert.equal(observed.creates, 1);
  }, { projects: true, [option]: true });
});

test("Project probe rejects a duplicate idempotency mismatch and mixed project lists", async () => {
  for (const option of ["duplicateReplayMismatch", "mixedList"]) await fixture(async ({ launch, observed }) => {
    await assert.rejects(launch(), probeFailure(/duplicate idempotency|listing mixed project scopes/));
    assert.equal(observed.submissions, 1);
    assert.equal(observed.quotes, 1);
  }, { projects: true, [option]: true });
});

test("Project profile updates must preserve the already admitted run snapshot", async () => {
  await fixture(async ({ launch, observed }) => {
    await assert.rejects(launch(), probeFailure(/profile changes mutated the admitted run snapshot/));
    assert.equal(observed.submissions, 1);
    assert.equal(observed.quotes, 1);
  }, { projects: true, mutateRunOnProfilePatch: true });
});

test("Project canonical readback detects changed profile, auxiliary graph and project association", async () => {
  for (const change of ["profile", "graph", "association", "prompt"]) await fixture(async ({ launch, file, observed, editProject, editProjectFlow, editRun }) => {
    await launch();
    const evidence = JSON.parse(await readFile(file, "utf8"));
    if (change === "profile") editProject(evidence.projectProbe.projects[0].id, project => ({ ...project, profile: { ...project.profile, voice: "Changed externally" } }));
    if (change === "graph") editProjectFlow(evidence.projectProbe.flows[2].id, flow => ({ ...flow, graph: { ...flow.graph, nodes: [] } }));
    if (change === "association") editProjectFlow(evidence.projectProbe.flows[2].id, flow => ({ ...flow, projectId: evidence.projectProbe.projects[0].id }));
    if (change === "prompt") editRun(run => ({ ...run, nodes: run.nodes.map(node => node.nodeId === "image" ? { ...node, effectivePrompt: `Unexpected extra instruction.\n${node.effectivePrompt}` } : node) }));
    const mutations = observed.mutations.length;
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback" }), probeFailure(/project\/profile changed|project flow or context changed|flow identity or context|effective prompts changed/));
    assert.equal(observed.mutations.length, mutations);
    assert.equal(observed.submissions, 1);
  }, { projects: true });
});

test("Project verification cannot be silently dropped or added during canonical readback", async () => {
  for (const projects of [true, false]) await fixture(async ({ launch, observed }) => {
    await launch();
    const requests = observed.requests.length;
    await assert.rejects(launch({ SMOKE_STUDIO_FLOW_MODE: "readback", SMOKE_STUDIO_PROJECTS: projects ? "" : "CONFIRMED" }),
      probeFailure(/same explicit project admission/));
    assert.equal(observed.requests.length, requests);
  }, { projects });
});

test("Project verification rejects live generation and recovery pins before network or evidence mutation", async () => {
  await fixture(async ({ launch, observed }) => {
    for (const overrides of [
      { STUDIO_SMOKE_MODE: "live", LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" },
      { LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" },
      { SMOKE_STUDIO_PROJECTS: "yes" },
    ]) await assert.rejects(launch(overrides));
    assert.equal(observed.requests.length, 0);
  }, { projects: true });
  await withRecovery(async ({ launch, observed, original, file, recoveryEnv }) => {
    const requests = observed.requests.length;
    await assert.rejects(launch({ ...recoveryEnv, SMOKE_STUDIO_PROJECTS: "CONFIRMED" }));
    assert.equal(observed.requests.length, requests);
    assert.deepEqual(await readFile(file), original);
  });
});
