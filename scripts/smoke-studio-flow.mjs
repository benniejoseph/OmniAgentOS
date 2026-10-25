#!/usr/bin/env node
/** One bounded Studio flow before promotion; the same records are read afterward. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  parseStudioReadbackRecovery,
  STUDIO_READBACK_ENV,
  verifyStudioReadbackRecovery,
} from "./studio-readback-recovery.mjs";

const production = "https://asael.bennierichard.com";
const base = new URL(required("BASE_URL"));
const loopback =
  process.env.SMOKE_STUDIO_ALLOW_LOOPBACK === "CONFIRMED" &&
  base.protocol === "http:" &&
  ["localhost", "127.0.0.1"].includes(base.hostname);
assert(
  (loopback ||
    (base.protocol === "https:" &&
      (base.origin === production ||
        /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/.test(
          base.origin,
        )))) &&
    base.pathname === "/" &&
    !base.search &&
    !base.hash &&
    !base.username &&
    !base.password,
  "Unapproved Studio candidate URL",
);
const revision = required("EXPECTED_REVISION");
const file = required("SMOKE_STUDIO_FLOW_EVIDENCE_FILE");
const mode = required("STUDIO_SMOKE_MODE");
const phase = process.env.SMOKE_STUDIO_FLOW_MODE || "exercise";
const recovery = parseStudioReadbackRecovery(process.env[STUDIO_READBACK_ENV], revision);
const recoveryStage = process.env.SMOKE_STUDIO_READBACK_STAGE;
if (recovery) {
  assert(phase === "readback" && ["staged", "canonical"].includes(recoveryStage),
    "Studio recovery only permits explicit staged/canonical readback");
  assert(!process.env.LIVE_VERIFY_STUDIO_GENERATION?.trim(),
    "Studio recovery cannot be combined with generation admission");
} else assert(!recoveryStage, "Studio recovery stage requires a hash-bound source receipt");
assert(
  ["demo", "live"].includes(mode),
  "STUDIO_SMOKE_MODE must explicitly select demo or live",
);
assert(["exercise", "readback"].includes(phase), "Unknown Studio probe phase");
assert(
  process.env.LIVE_VERIFY_STUDIO_FLOW === "CONFIRMED",
  "Explicit Studio scenario admission required",
);
if (mode === "live" && phase === "exercise")
  assert(
    process.env.LIVE_VERIFY_STUDIO_GENERATION === "CONFIRMED",
    "One paid image and one paid video require explicit generation admission",
  );
const email = required("SMOKE_PAID_AGENT_EMAIL"),
  password = required("SMOKE_PAID_AGENT_PASSWORD");
const internalSecret = required("SMOKE_INTERNAL_AUTH_SECRET"),
  bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const maxCostUsd = 3.5,
  maxGenerations = 2;
const timeoutMs = bounded(
  process.env.SMOKE_STUDIO_TIMEOUT_MS,
  720_000,
  1_000,
  900_000,
);
const pollMs = bounded(
  process.env.SMOKE_STUDIO_POLL_MS,
  5_000,
  loopback ? 1 : 5_000,
  30_000,
);
let cookie = "",
  failure,
  signedOut = false,
  ownsEvidence = false;
let evidence = {
  scenario: "studio_flow_v1",
  revision,
  mode,
  status: "pending",
  resourcesRetained: true,
  maxCostUsd,
  maxGenerations,
};

try {
  if (recovery) {
    const { source, linkage } = await verifyStudioReadbackRecovery(recovery, { mode, outputFile: file });
    if (recoveryStage === "staged") {
      evidence = { ...source, revision, status: "pending", recovery: linkage,
        newGenerationAttempts: 0, stagedReadback: false, canonicalReadback: false };
      delete evidence.failure;
      await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      ownsEvidence = true;
    } else {
      evidence = JSON.parse(await readFile(file, "utf8"));
      assert(evidence.revision === revision && evidence.mode === mode && evidence.stagedReadback === true &&
        evidence.scenario === source.scenario && evidence.exerciseStatus === "passed" &&
        evidence.flowId === source.flowId && evidence.runId === source.runId &&
        evidence.flowRevision === source.flowRevision && evidence.graphSha256 === source.graphSha256 &&
        evidence.ownerHash === source.ownerHash && hash(evidence.assets) === hash(source.assets) &&
        hash(evidence.recovery) === hash(linkage) && evidence.newGenerationAttempts === 0,
      "Studio recovery output does not match the preserved source and staged readback");
      ownsEvidence = true;
    }
  } else if (phase === "exercise") {
    // A new process cannot accidentally start another paid attempt using the same release receipt.
    await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    ownsEvidence = true;
    evidence.marker = randomUUID();
    await save();
  } else {
    evidence = JSON.parse(await readFile(file, "utf8"));
    assert(
      evidence.scenario === "studio_flow_v1" &&
        evidence.revision === revision &&
        evidence.mode === mode &&
        evidence.exerciseStatus === "passed",
      "Stored Studio scenario does not match this release",
    );
    ownsEvidence = true;
  }
  const health = await json("/api/health");
  assert(
    health.status === "healthy" && health.revision === revision,
    "Candidate health or revision mismatch",
  );
  const login = await request("/api/auth/login", { email, password });
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(
    login.status === 200 && cookie,
    "Fresh Studio scenario sign-in failed",
  );
  const auth = JSON.parse((await bytes(login, 2_000_000)).toString("utf8"));
  assert(
    auth.authenticated &&
      auth.context?.source === "session" &&
      auth.context?.actorId &&
      auth.context?.tenantId,
    "Studio scenario requires a signed-in owner",
  );
  const ownerHash = hash([
    auth.context.tenantId,
    auth.context.actorId,
    auth.context.auth?.userId ?? null,
  ]);
  if (phase === "readback")
    assert(
      evidence.ownerHash === ownerHash,
      "Saved Studio scenario belongs to another owner",
    );
  else {
    evidence.ownerHash = ownerHash;
    evidence.tenantId = auth.context.tenantId;
    const prefix = mode === "live" ? "google" : "demo";
    const ids = [`${prefix}-image-generate`, `${prefix}-video-image`];
    const { capabilities } = await json("/api/studio/capabilities");
    for (const [index, id] of ids.entries()) {
      const cap = capabilities?.find((item) => item.id === id);
      assert(
        cap?.available === true &&
          cap.maxOutputs === (mode === "demo" && index === 0 ? 3 : 1),
        `Required Studio capability ${id} is unavailable`,
      );
      assert(
        cap.model ===
          (mode === "demo"
            ? "studio-fixture-v1"
            : index === 0
              ? "gemini-3.1-flash-image"
              : "gemini-omni-1.1-flash"),
        "Studio model pin differs from the bounded plan",
      );
    }
    const graph = scenarioGraph(prefix);
    evidence.graphSha256 = hash(graph);
    const { flow } = await json(
      "/api/studio/flows",
      {
        name: `Studio validation ${evidence.marker}`,
        description:
          "Synthetic release verification: one original image, one image-to-video continuation, durable gallery and exact-record readback.",
        graph,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      "create-flow",
    );
    assert(
      flow?.id && flow.revision === 1,
      "Saved Studio flow identity missing",
    );
    evidence.flowId = flow.id;
    evidence.flowRevision = flow.revision;
    await save();
    const scope = { mode: "flow", regenerate: false };
    const { quote } = await json(
      `/api/studio/flows/${encodeURIComponent(flow.id)}/quote`,
      { revision: flow.revision, scope },
      "quote",
    );
    assert(
      quote?.id &&
        quote.generationCount === maxGenerations &&
        quote.reusedNodeIds?.length === 0 &&
        quote.issues?.every((issue) => issue.severity !== "error"),
      "Studio quote is not a fresh valid two-generation flow",
    );
    assert(
      quote.estimate?.status !== "unknown" &&
        quote.requiresUnknownCostConsent === false &&
        Number.isFinite(quote.estimate.maximumUsd) &&
        quote.estimate.maximumUsd >= 0 &&
        quote.estimate.maximumUsd <= maxCostUsd,
      "Studio quote exceeds the bounded authorization",
    );
    assert(
      Math.abs(quote.estimate.maximumUsd - (mode === "demo" ? 0 : 3.2768)) <
        0.000001,
      "Studio price reservation changed from the reviewed provider contract",
    );
    evidence.quoteId = quote.id;
    evidence.reservedApiCostUsd = quote.estimate.maximumUsd;
    await save();
    // Exactly one run-create request. A transport failure never creates a replacement or retry.
    const { run } = await json(
      `/api/studio/flows/${encodeURIComponent(flow.id)}/runs`,
      {
        quoteId: quote.id,
        scope,
        maxCostUsd,
        maxGenerations,
        allowUnknownCost: false,
      },
      "create-run",
    );
    assert(
      run?.id,
      "Studio run receipt missing; reconcile the retained flow instead of repeating generation",
    );
    evidence.runId = run.id;
    await save();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const detail = await json(
        `/api/studio/runs/${encodeURIComponent(evidence.runId)}`,
      );
      evidence.lastStatus = detail.run?.status;
      evidence.nodeStates = (detail.run?.nodes || []).map(
        ({ nodeId, status, errorCode }) => ({ nodeId, status, errorCode }),
      );
      await save();
      if (detail.run?.status === "succeeded") break;
      assert(
        !["failed", "partial", "canceled", "uncertain"].includes(
          detail.run?.status,
        ),
        `Studio flow stopped with ${detail.run?.status}; no generation was repeated`,
      );
      assert(
        !detail.run?.nodes?.some(
          (node) => node.status === "persisting" && node.error,
        ),
        "Generated media could not be saved; preserve the receipt and investigate without another generation",
      );
      assert(
        Date.now() < deadline,
        "Studio scenario deadline elapsed; the same run is retained for reconciliation",
      );
      await json(
        `/api/studio/runs/${encodeURIComponent(evidence.runId)}`,
        { action: "advance" },
        `advance-${evidence.advanceCount || 0}`,
      );
      evidence.advanceCount = (evidence.advanceCount || 0) + 1;
      await save();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  const previousAssets = evidence.assets;
  const { flow } = await json(
    `/api/studio/flows/${encodeURIComponent(evidence.flowId)}`,
  );
  assert(
    flow?.id === evidence.flowId &&
      Number.isSafeInteger(flow.revision) && flow.revision >= evidence.flowRevision &&
      hash(flow.graph) === evidence.graphSha256,
    "Saved Studio flow changed during verification",
  );
  evidence.observedFlowRevision = flow.revision;
  const { run } = await json(
    `/api/studio/runs/${encodeURIComponent(evidence.runId)}`,
  );
  assert(
    run?.id === evidence.runId &&
      run.flowId === evidence.flowId &&
      run.flowRevision === evidence.flowRevision &&
      run.status === "succeeded" &&
      hash(run.graph) === evidence.graphSha256,
    "Studio run is not the successful immutable quoted revision",
  );
  assert(
    run.maxCostUsd === maxCostUsd && run.maxGenerations === maxGenerations,
    "Studio run lost its accepted bounds",
  );
  const image = run.nodes?.find((node) => node.nodeId === "image"),
    video = run.nodes?.find((node) => node.nodeId === "video"),
    gallery = run.nodes?.find((node) => node.nodeId === "gallery");
  for (const node of [image, video])
    assert(
      node?.status === "succeeded" &&
        node.attempts?.length === 1 &&
        node.attempts[0].status === "succeeded" &&
        node.attempts[0].providerRequestId &&
        node.outputAssets?.length === 1,
      "Expected one successful provider attempt and output per generator",
    );
  assert(
    image.attempts[0].providerRequestId !== video.attempts[0].providerRequestId,
    "Image and video share an invalid provider receipt",
  );
  assert(
    video.inputAssets?.length === 1 &&
      video.inputAssets[0].id === image.outputAssets[0].id &&
      video.inputAssets[0].contentSha256 ===
        image.outputAssets[0].contentSha256,
    "Video did not consume the exact generated image",
  );
  assert(
    gallery?.status === "succeeded" &&
      gallery.outputAssets?.length === 2 &&
      [image, video].every((node) =>
        gallery.outputAssets.some(
          (asset) => asset.id === node.outputAssets[0].id,
        ),
      ),
    "Gallery did not preserve both outputs",
  );
  const proofs = [];
  for (const node of [image, video]) {
    const output = node.outputAssets[0];
    const { asset } = await json(
      `/api/capture/assets/${encodeURIComponent(output.id)}`,
    );
    const metadata = asset?.metadata;
    const expectedModel =
      mode === "demo"
        ? "studio-fixture-v1"
        : node.nodeId === "image"
          ? "gemini-3.1-flash-image"
          : "gemini-omni-1.1-flash";
    assert(
      asset?.contentSha256 === output.contentSha256 &&
        asset?.byteCount === output.byteCount &&
        asset.mediaType.startsWith(`${node.nodeId}/`),
      "Durable asset metadata differs from its run output",
    );
    assert(
      metadata?.studioRunId === run.id &&
        metadata?.studioFlowId === flow.id &&
        metadata?.studioNodeId === node.nodeId &&
        metadata?.studioAttemptId === node.attempts[0].id &&
        metadata?.providerRequestId === node.attempts[0].providerRequestId &&
        metadata?.provider === (mode === "demo" ? "demo" : "google") &&
        metadata?.model === expectedModel &&
        metadata?.studioDemo === (mode === "demo"),
      "Generated asset provenance does not match its exact attempt",
    );
    const response = await request(
      `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1&download=1`,
    );
    assert(
      response.status === 200 &&
        response.headers.get("content-type")?.split(";")[0] === asset.mediaType,
      "Generated asset cannot be downloaded as its declared media",
    );
    const content = await bytes(response, 20 * 1024 * 1024);
    assert(
      content.byteLength === asset.byteCount &&
        hashBytes(content) === asset.contentSha256,
      "Generated asset download failed byte/hash verification",
    );
    assert(
      node.nodeId === "image"
        ? metadata.width > 0 && metadata.height > 0
        : metadata.durationSeconds > 0,
      "Decoded image dimensions or video duration are missing",
    );
    proofs.push({
      nodeId: node.nodeId,
      id: asset.id,
      contentSha256: asset.contentSha256,
      byteCount: asset.byteCount,
      mediaType: asset.mediaType,
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
      provider: metadata.provider,
      model: metadata.model,
      providerRequestId: metadata.providerRequestId,
      attemptId: metadata.studioAttemptId,
      demo: metadata.studioDemo,
    });
  }
  if (phase === "readback")
    assert(
      hash(previousAssets) === hash(proofs),
      "Canonical readback does not match the original asset receipts",
    );
  evidence.assets = proofs;
  evidence.verifiedGenerationAttempts =
    image.attempts.length + video.attempts.length;
  assert(
    (await json("/api/health")).revision === revision,
    "Revision changed during Studio verification",
  );
  evidence.status = "passed";
  delete evidence.failure;
  if (phase === "readback") {
    if (recoveryStage !== "staged") evidence.canonicalReadback = true;
  }
} catch (error) {
  failure = error;
  evidence.status = "failed";
  evidence.failure = safe(
    error.code === "EEXIST"
      ? "Studio evidence already exists. Reconcile/read back the original run; exercise never repeats automatically."
      : error.message || "Studio scenario failed",
  );
} finally {
  if (cookie)
    try {
      const out = await json("/api/auth/logout", {}, "logout");
      assert(out.authenticated === false, "Studio sign-out incomplete");
      signedOut = true;
    } catch {
      failure ||= new Error("Studio scenario sign-out failed");
    }
  evidence.signedOut = signedOut;
  if (failure) evidence.status = "failed";
  if (recoveryStage === "staged") evidence.stagedReadback = !failure;
  if (phase === "exercise")
    evidence.exerciseStatus = failure ? "failed" : "passed";
  if (ownsEvidence) await save();
}
console.log(
  JSON.stringify(
    {
      ...evidence,
      tenantId: undefined,
      ownerHash: undefined,
      status: failure ? "FAIL" : "PASS",
    },
    null,
    2,
  ),
);
if (failure) process.exitCode = 1;

function scenarioGraph(prefix) {
  const node = (id, type, x, config) => ({
    id,
    type,
    title: id,
    position: { x, y: 0 },
    enabled: true,
    config: { parameters: {}, ...config },
  });
  const edge = (id, source, sourcePort, target, targetPort, order) => ({
    id,
    source,
    sourcePort,
    target,
    targetPort,
    order,
  });
  return {
    schemaVersion: 1,
    nodes: [
      node("prompt", "prompt", 0, {
        prompt:
          "Create an original minimalist cinematic image of a freestanding stone arch above a calm lavender sea at dawn. No text, people, logos or copyrighted characters. Landscape composition.",
      }),
      node("image", "image", 340, {
        capabilityId: `${prefix}-image-generate`,
        parameters: { outputCount: 1, imageSize: "1K", aspectRatio: "16:9" },
      }),
      node("video", "video", 680, {
        capabilityId: `${prefix}-video-image`,
        prompt:
          "Animate the supplied arch image with gentle water ripples and a subtle forward camera movement. Preserve the arch and composition. No text, new subjects or abrupt cuts.",
        parameters: { outputCount: 1, resolution: "720p", aspectRatio: "16:9" },
      }),
      node("gallery", "output", 1020, {}),
    ],
    edges: [
      edge("prompt-image", "prompt", "text", "image", "prompt", 0),
      edge("image-video", "image", "selected", "video", "start", 0),
      edge("image-gallery", "image", "images", "gallery", "media", 0),
      edge("video-gallery", "video", "videos", "gallery", "media", 1),
    ],
  };
}
function required(name) {
  const value = process.env[name];
  assert(value?.trim(), `${name} required`);
  return value;
}
function bounded(raw, fallback, min, max) {
  const value = raw ? Number(raw) : fallback;
  assert(
    Number.isInteger(value) && value >= min && value <= max,
    "Invalid Studio probe timing bound",
  );
  return value;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function hash(value) {
  return hashBytes(canonical(value));
}
function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
function safe(value) {
  let text = String(value);
  for (const secret of [email, password, internalSecret, bypass, cookie])
    if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.slice(0, 600);
}
async function save() {
  await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function request(path, body, step) {
  assert(phase !== "readback" || body === undefined || ["/api/auth/login", "/api/auth/logout"].includes(path),
    "Studio readback cannot mutate resources or advance execution");
  const headers = {
    origin: production,
    "x-omni-synthetic-auth": internalSecret,
    "x-omni-synthetic-source": "studio-flow-release-verification",
    "x-omni-slo-excluded": "true",
    ...(cookie ? { cookie } : {}),
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    ...(body === undefined
      ? {}
      : {
          "content-type": "application/json",
          "idempotency-key": `studio-smoke:${evidence.marker || "readback"}:${step || "login"}`,
        }),
  };
  return fetch(`${base.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
    redirect: "manual",
    cache: "no-store",
  });
}
async function json(path, body, step) {
  const response = await request(path, body, step);
  assert(
    response.status === 200,
    `${body === undefined ? "GET" : "POST"} ${path} returned HTTP ${response.status}`,
  );
  return JSON.parse((await bytes(response, 2_000_000)).toString("utf8"));
}
async function bytes(response, limit) {
  const reader = response.body?.getReader();
  assert(reader, "Missing Studio response body");
  const chunks = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Studio response exceeded its byte bound");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks, size);
}
