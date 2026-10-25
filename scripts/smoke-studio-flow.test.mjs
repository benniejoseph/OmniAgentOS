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
  const observed = {
    creates: 0,
    submissions: 0,
    advances: 0,
    mutations: [],
    wrongHash: false,
    actorId: "fixture@example.test",
    unsignedAdmission: false,
    requests: [],
  };
  const mode = options.mode || "demo";
  const provider = mode === "live" ? "google" : "demo";
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const value = raw ? JSON.parse(raw) : {};
      const url = request.url;
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
      else if (url === "/api/studio/flows" && request.method === "POST") {
        observed.creates++;
        flow = { ...value, id: "flow-1", revision: 1 };
        payload = { flow };
      } else if (url === "/api/studio/flows/flow-1") payload = { flow };
      else if (url === "/api/studio/flows/flow-1/quote")
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
      else if (url === "/api/studio/flows/flow-1/runs") {
        observed.submissions++;
        assert.equal(value.maxCostUsd, 3.5);
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
          graph: flow.graph,
          status: "queued",
          maxCostUsd: 3.5,
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
      editFlow: (edit) => { flow = edit(structuredClone(flow)); },
      editRun: (edit) => { run = edit(structuredClone(run)); },
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
