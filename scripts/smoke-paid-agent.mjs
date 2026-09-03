#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";

const confirmation = "CONFIRMED";
const productionOrigin = "https://asael.bennierichard.com";
const stagedOriginPattern =
  /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;
const paidPrompt = "hello";
const paidResponse = "ASAEL_LIVE_OK";
const paidResponseSha256 = createHash("sha256")
  .update(paidResponse)
  .digest("hex");
if (process.env.LIVE_VERIFY_PAID_OPENAI !== confirmation) {
  throw new Error(
    `Set LIVE_VERIFY_PAID_OPENAI=${confirmation} to authorize one paid OpenAI turn.`,
  );
}

const expectedRevision = required("EXPECTED_REVISION");
const internalSecret = (
  process.env.SMOKE_INTERNAL_AUTH_SECRET ||
  process.env.OMNIAGENT_INTERNAL_AUTH_SECRET ||
  ""
).trim();
if (!internalSecret) {
  throw new Error("SMOKE_INTERNAL_AUTH_SECRET is required.");
}
const bypassSecret =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "";
const baseUrl = validatedBaseUrl(required("BASE_URL"));
const marker = randomUUID();
const suffix = marker.replaceAll("-", "").slice(0, 12);
const tenantId = `paid_verify_${Date.now()}_${suffix}`;
const actorId = `paid-verifier-${suffix}`;
const requestId = `paid_verify:${marker}`;
const headers = {
  "x-omni-internal-auth": internalSecret,
  "x-omni-synthetic-auth": internalSecret,
  "x-omni-synthetic-source": "paid-agent-release-verification",
  "x-omni-slo-excluded": "true",
  "x-omni-correlation-id": requestId,
  "x-omni-tenant-id": tenantId,
  "x-omni-user-id": actorId,
  "x-omni-user-role": "admin",
  ...(bypassSecret
    ? { "x-vercel-protection-bypass": bypassSecret }
    : {}),
};

let agentId;
let runId;
let health;
let tokenReceipt;
let trajectoryRevision;
let primaryFailure;
let cleanupFailure;
let agentDeleted = false;

try {
  health = await jsonRequest("/api/health", {}, 200);
  assert(health.status === "healthy", "Deployment health is not healthy.");
  assert(
    health.revision === expectedRevision,
    "Deployment revision does not match EXPECTED_REVISION.",
  );
  assert(
    health.dependencies?.openAiConfigured === true,
    "OpenAI is not configured on this revision.",
  );

  const name = `Paid Release Verifier ${suffix}`;
  const created = await jsonRequest(
    "/api/agents",
    {
      method: "POST",
      body: {
        name,
        role: "Release verifier",
        description: `Synthetic paid release verifier ${marker}`,
        instructions: "Reply only ASAEL_LIVE_OK",
        status: "ready",
        accent: "emerald",
        modelPolicy: "openai_fast",
        autonomy: "assist",
        approvalPolicy: "read_only",
        memoryScope: "session",
        skillIds: [],
        toolIds: [],
      },
    },
    201,
  );
  agentId = created.agent?.id;
  assert(
    typeof agentId === "string" && agentId.length > 0,
    "Agent creation returned no id.",
  );
  assert(
    created.agent.tenantId === tenantId,
    "Created agent escaped the synthetic tenant.",
  );

  const patchedDescription =
    `Synthetic paid release verifier ${marker} (patched)`;
  const patched = await jsonRequest(
    `/api/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PATCH",
      body: {
        description: patchedDescription,
        accent: "blue",
      },
    },
    200,
  );
  assert(
    patched.agent?.description === patchedDescription,
    "Agent PATCH did not persist the description.",
  );
  assert(
    patched.agent?.accent === "blue",
    "Agent PATCH did not persist the accent.",
  );
  assert(
    patched.agent?.modelPolicy === "openai_fast",
    "Agent PATCH changed the OpenAI fast routing policy.",
  );

  const response = await rawRequest("/api/agent", {
    method: "POST",
    timeoutMs: 180_000,
    extraHeaders: { "idempotency-key": requestId },
    body: {
      messages: [{ role: "user", content: paidPrompt }],
      mode: "orchestrate",
      strategy: "direct",
      agentId,
      requestId,
    },
  });
  assert(
    response.status === 200,
    `Agent request returned HTTP ${response.status}.`,
  );
  assert(
    (response.headers.get("content-type") || "").includes(
      "text/event-stream",
    ),
    "Agent response was not SSE.",
  );
  const events = parseSse(await readTextLimited(response, 2_000_000));
  const errorEvent = events.find((event) => event.type === "error");
  assert(
    !errorEvent,
    `Agent stream failed: ${safeText(errorEvent?.message || "unknown error")}.`,
  );
  assert(
    !events.some((event) => event.type === "delegated"),
    "Minimal direct turn was unexpectedly delegated.",
  );
  assert(
    !events.some((event) => event.type === "tool"),
    "Tool-free verifier unexpectedly invoked a tool.",
  );

  const runEvent = events.find((event) => event.type === "run");
  runId = runEvent?.runId;
  assert(
    typeof runId === "string" && runId.length > 0,
    "Agent stream returned no run id.",
  );
  const modelEvents = events.filter((event) => event.type === "model");
  assert(modelEvents.length === 1, "Expected exactly one model turn.");
  const modelEvent = modelEvents[0];
  assert(modelEvent.provider === "openai", "Paid turn did not use OpenAI.");
  assert(
    modelEvent.fallbackUsed === false,
    "Minimal OpenAI turn used a fallback.",
  );
  assert(
    positive(modelEvent.inputTokens),
    "OpenAI input token receipt is missing.",
  );
  assert(
    positive(modelEvent.outputTokens),
    "OpenAI output token receipt is missing.",
  );
  assert(
    positive(modelEvent.totalTokens) &&
      Number(modelEvent.totalTokens) >=
        Number(modelEvent.inputTokens) + Number(modelEvent.outputTokens),
    "OpenAI total token receipt is invalid.",
  );
  const doneEvents = events.filter((event) => event.type === "done");
  assert(doneEvents.length === 1, "Agent stream did not complete exactly once.");
  assert(
    doneEvents[0].response === paidResponse,
    "Agent response did not match the release sentinel.",
  );
  tokenReceipt = {
    input: modelEvent.inputTokens,
    output: modelEvent.outputTokens,
    total: modelEvent.totalTokens,
  };

  const replay = await jsonRequest(
    `/api/runs/${encodeURIComponent(runId)}?replay=true`,
    {},
    200,
  );
  assert(
    replay.consistent === true,
    "Run replay is inconsistent with persisted state.",
  );
  assert(replay.run?.status === "completed", "Persisted run is not completed.");
  assert(
    replay.run?.prompt === paidPrompt && replay.run?.messageCount === 1,
    "Persisted run does not contain the exact paid verification prompt.",
  );
  assert(
    replay.run?.agentId === agentId,
    "Persisted run is not bound to the temporary agent.",
  );
  assert(
    replay.replayed?.status === "completed",
    "Replayed run is not completed.",
  );
  assert(positive(replay.eventCount), "Run replay contains no events.");
  assert(
    replay.run?.consolidationCount === 0 && !replay.run?.consolidatedAt,
    "Minimal paid turn unexpectedly entered memory consolidation.",
  );

  const exported = await jsonRequest(
    `/api/runs/${encodeURIComponent(runId)}/trajectory`,
    {},
    200,
  );
  const trajectory = exported.trajectory;
  assert(
    exported.verification?.valid === true,
    "Trajectory verification failed.",
  );
  assert(trajectory?.run?.id === runId, "Trajectory references the wrong run.");
  assert(
    trajectory?.run?.tenantId === tenantId,
    "Trajectory escaped the synthetic tenant.",
  );
  assert(
    trajectory?.run?.agentId === agentId,
    "Trajectory references the wrong agent.",
  );
  assert(
    trajectory?.request?.promptLength === paidPrompt.length &&
      trajectory?.request?.messageCount === 1,
    "Trajectory request receipt does not match the paid verification prompt.",
  );
  trajectoryRevision = trajectory?.runtime?.revision;
  assert(
    trajectoryRevision === expectedRevision,
    "Trajectory was not produced by the expected revision.",
  );
  assert(
    Array.isArray(trajectory?.providers) &&
      trajectory.providers.length === 1 &&
      trajectory.providers[0] === "openai",
    "Trajectory contains a non-OpenAI provider.",
  );
  assert(
    Array.isArray(trajectory?.models) &&
      trajectory.models.length === 1 &&
      trajectory.models[0] === modelEvent.model,
    "Trajectory model does not match the streamed model receipt.",
  );
  const trajectoryEvents = Array.isArray(trajectory?.events)
    ? trajectory.events
    : [];
  const trajectoryModelEvents = trajectoryEvents.filter(
    (event) => event.type === "run.model",
  );
  assert(
    trajectoryModelEvents.length === 1,
    "Trajectory must contain exactly one model event.",
  );
  const trajectoryModel = trajectoryModelEvents[0]?.receipt || {};
  assert(
    trajectoryModel.provider === modelEvent.provider &&
      trajectoryModel.model === modelEvent.model &&
      Number(trajectoryModel.inputTokens) === Number(modelEvent.inputTokens) &&
      Number(trajectoryModel.outputTokens) === Number(modelEvent.outputTokens) &&
      Number(trajectoryModel.totalTokens) === Number(modelEvent.totalTokens) &&
      trajectoryModel.fallbackUsed === false,
    "Trajectory model receipt does not match the streamed OpenAI receipt.",
  );
  const trajectoryDoneEvents = trajectoryEvents.filter(
    (event) => event.type === "run.done",
  );
  assert(
    trajectoryDoneEvents.length === 1 &&
      Number(trajectoryDoneEvents[0]?.receipt?.responseLength) ===
        paidResponse.length &&
      trajectoryDoneEvents[0]?.receipt?.responseSha256 ===
        paidResponseSha256,
    "Trajectory terminal receipt does not match the release sentinel.",
  );
  assert(
    positive(trajectory?.usage?.inputTokens),
    "Trajectory input token total is missing.",
  );
  assert(
    positive(trajectory?.usage?.outputTokens),
    "Trajectory output token total is missing.",
  );
  assert(
    positive(trajectory?.usage?.totalTokens),
    "Trajectory total token receipt is missing.",
  );
  assert(
    trajectory?.usage?.fallbackCount === 0,
    "Trajectory recorded a model fallback.",
  );
  assert(
    Array.isArray(trajectory?.toolExecutionIds) &&
      trajectory.toolExecutionIds.length === 0,
    "Trajectory unexpectedly contains tool executions.",
  );
  const forbiddenTrajectoryTypes = new Set([
    "run.tool",
    "run.waiting_approval",
    "run.memory",
    "run.council_member",
    "run.council_verdict",
  ]);
  assert(
    trajectoryEvents.every(
      (event) => !forbiddenTrajectoryTypes.has(event.type),
    ),
    "Trajectory unexpectedly contains memory, tool, or council events.",
  );
  assert(
    !trajectoryEvents.some(
      (event) =>
        event.type === "run.status" &&
        String(event.receipt?.label || "").includes("memory consolidation"),
    ),
    "Trajectory recorded an unexpected memory consolidation transition.",
  );

  const closingHealth = await jsonRequest("/api/health", {}, 200);
  assert(
    closingHealth.status === "healthy" &&
      closingHealth.revision === expectedRevision,
    "Deployment revision changed during verification.",
  );
} catch (error) {
  primaryFailure = error;
} finally {
  if (agentId) {
    try {
      const deleted = await jsonRequest(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
        200,
      );
      assert(deleted.deleted === true, "Agent deletion was not acknowledged.");
      agentDeleted = true;
    } catch (error) {
      cleanupFailure = error;
    }
  }
}

if (primaryFailure || cleanupFailure) {
  const reasons = [primaryFailure, cleanupFailure]
    .filter(Boolean)
    .map((error) =>
      safeText(error instanceof Error ? error.message : String(error)),
    );
  console.error(`FAIL paid agent verification: ${reasons.join(" Cleanup: ")}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        revision: health.revision,
        trajectoryRevision,
        tenantId,
        agentId,
        runId,
        provider: "openai",
        tokens: tokenReceipt,
        runReplayConsistent: true,
        trajectoryVerified: true,
        agentDeleted,
      },
      null,
      2,
    ),
  );
}

async function rawRequest(path, options = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("accept", options.accept || "application/json");
  if (options.body !== undefined) {
    requestHeaders.set("content-type", "application/json");
  }
  for (const [key, value] of Object.entries(options.extraHeaders || {})) {
    requestHeaders.set(key, value);
  }
  return fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: requestHeaders,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
}

async function jsonRequest(path, options = {}, expectedStatus = 200) {
  const response = await rawRequest(path, options);
  const text = await readTextLimited(response, 2_000_000);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `${options.method || "GET"} ${path} expected HTTP ${expectedStatus}, ` +
        `received ${response.status}.`,
    );
  }
  return body;
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Verification response exceeded the safe size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return [];
    try {
      return [JSON.parse(data)];
    } catch {
      throw new Error("Agent stream contained invalid SSE JSON.");
    }
  });
}

function validatedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BASE_URL must be a valid absolute URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const loopbackAllowed =
    process.env.SMOKE_PAID_AGENT_ALLOW_LOOPBACK === confirmation;
  const isAllowedLoopback =
    loopbackAllowed && loopback && url.protocol === "http:";
  const isCanonicalUrlText =
    value === url.origin || value === `${url.origin}/`;
  const isAllowedProductionTarget =
    url.protocol === "https:" &&
    isCanonicalUrlText &&
    (url.origin === productionOrigin || stagedOriginPattern.test(url.origin));
  if (
    (!isAllowedLoopback && !isAllowedProductionTarget) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BASE_URL is not an approved Asael release target.");
  }
  return url.origin;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeText(value) {
  let redacted = String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]");
  for (const secret of [internalSecret, bypassSecret]) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted-secret]");
  }
  return redacted
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .slice(0, 500);
}
