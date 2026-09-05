#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const baseUrl = required("BASE_URL").replace(/\/+$/, "");
const expectedRevision = required("EXPECTED_REVISION");
const internalSecret = (
  process.env.SMOKE_INTERNAL_AUTH_SECRET ||
  process.env.OMNIAGENT_INTERNAL_AUTH_SECRET ||
  ""
).trim();
const tenantId = required("SMOKE_TENANT_ID");
const actorId = required("SMOKE_ACTOR_ID");
const recoveryCanary = process.env.CHECKPOINT_RECOVERY_CANARY === "true";

if (!internalSecret) {
  throw new Error(
    "SMOKE_INTERNAL_AUTH_SECRET or OMNIAGENT_INTERNAL_AUTH_SECRET is required.",
  );
}
if (baseUrl !== "https://asael.bennierichard.com") {
  throw new Error("Expanded checkpoint smoke must target the production origin.");
}

const marker = randomUUID();
const suffix = marker.replaceAll("-", "").slice(0, 12);
const requestHeaders = {
  "x-omni-internal-auth": internalSecret,
  "x-omni-synthetic-auth": internalSecret,
  "x-omni-synthetic-source": "expanded-checkpoint-verification",
  "x-omni-slo-excluded": "true",
  "x-omni-tenant-id": tenantId,
  "x-omni-user-id": actorId,
  "x-omni-user-role": "admin",
};
const createdAgentIds = [];
const runIds = [];

try {
  const health = await jsonRequest("/api/health");
  assert(health.status === "healthy", "Production health is not healthy.");
  assert(
    health.revision === expectedRevision,
    "Production revision does not match EXPECTED_REVISION.",
  );

  const approvalAgent = await createAgent({
    name: `Checkpoint Approval ${suffix}`,
    role: "Checkpoint approval verifier",
    description: `Synthetic expanded-checkpoint approval verifier ${marker}`,
    instructions: recoveryCanary
      ? "Call runs.list exactly once with limit 1 before answering. Do not call any other tool. After the tool result, write a detailed 900-1200 word assessment of checkpoint recovery safety and do not call the tool again."
      : "Call runs.list exactly once with limit 1 before answering. Do not call any other tool. After the tool result, reply with one short sentence and do not call the tool again.",
    autonomy: "assist",
    approvalPolicy: "always",
    toolIds: ["runs.list"],
  });
  const approvalRequestId = `checkpoint_approval:${marker}`;
  const approvalEvents = await agentRequest({
    agentId: approvalAgent,
    requestId: approvalRequestId,
    mode: "orchestrate",
    message:
      recoveryCanary
        ? "List one recent run, then provide the requested detailed checkpoint recovery safety assessment."
        : "List one recent run with the available tool and report that the controlled read completed.",
  });
  const approvalRunId = oneEvent(approvalEvents, "run").runId;
  const waiting = oneEvent(approvalEvents, "waiting_approval");
  runIds.push(approvalRunId);
  assert(waiting.toolId === "runs.list", "Approval canary selected the wrong tool.");
  assert(
    !approvalEvents.some((event) => event.type === "done"),
    "Approval canary completed before the required decision.",
  );

  const approval = await jsonRequest(
    `/api/approvals/${encodeURIComponent(waiting.executionId)}`,
    {
      method: "POST",
      body: {
        kind: "tool",
        decision: "approve",
        reason: "Expanded checkpoint production shadow verification.",
      },
    },
  );
  assert(
    approval.record?.status === "executed",
    "Approved read-only tool did not execute.",
  );
  assert(
    approval.continuation?.scheduled === true,
    "Approved run continuation was not scheduled.",
  );
  const completedApprovalRun = await waitForRun(
    approvalRunId,
    waiting.executionId,
  );
  assert(
    completedApprovalRun.run?.status === "completed",
    `Approval canary ended as ${completedApprovalRun.run?.status || "unknown"}.`,
  );
  assert(
    completedApprovalRun.consistent === true,
    "Approval canary replay is inconsistent.",
  );

  const councilAgent = await createAgent({
    name: `Checkpoint Council ${suffix}`,
    role: "Checkpoint council verifier",
    description: `Synthetic expanded-checkpoint council verifier ${marker}`,
    instructions:
      "Answer concisely, do not call tools, and preserve the requested safety and evidence review.",
    autonomy: "assist",
    approvalPolicy: "risk_based",
    toolIds: [],
  });
  const councilRequestId = `checkpoint_council:${marker}`;
  const councilEvents = await agentRequest({
    agentId: councilAgent,
    requestId: councilRequestId,
    mode: "execute",
    message:
      "Research and compare two approaches for validating a production checkpoint boundary, recommend the safer one, and have the result reviewed for risk and evidence. Do not use any tools.",
  });
  const councilRunId = oneEvent(councilEvents, "run").runId;
  runIds.push(councilRunId);
  assert(
    councilEvents.some(
      (event) => event.type === "council_member" && event.status === "completed",
    ),
    "Council canary recorded no completed specialist.",
  );
  assert(
    councilEvents.some((event) => event.type === "council_verdict"),
    "Council canary recorded no Sentinel verdict.",
  );
  assert(
    councilEvents.some((event) => event.type === "done"),
    "Council canary did not complete.",
  );
  assert(
    !councilEvents.some(
      (event) => event.type === "tool" || event.type === "waiting_approval",
    ),
    "Council canary unexpectedly entered a tool boundary.",
  );
  const completedCouncilRun = await jsonRequest(
    `/api/runs/${encodeURIComponent(councilRunId)}?replay=true`,
  );
  assert(
    completedCouncilRun.run?.status === "completed" &&
      completedCouncilRun.consistent === true,
    "Council canary replay is not complete and consistent.",
  );

  console.log(
    JSON.stringify({
      status: "PASS",
      revision: health.revision,
      tenantId,
      approvalRunId,
      councilRunId,
      approvalExecutionId: waiting.executionId,
      councilVerdict: councilEvents.find(
        (event) => event.type === "council_verdict",
      )?.status,
    }),
  );
} finally {
  const cleanupErrors = [];
  for (const agentId of createdAgentIds.reverse()) {
    try {
      await jsonRequest(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (cleanupErrors.length) {
    throw new Error(`Checkpoint canary cleanup failed: ${cleanupErrors.join("; ")}`);
  }
}

async function createAgent({
  name,
  role,
  description,
  instructions,
  autonomy,
  approvalPolicy,
  toolIds,
}) {
  const response = await jsonRequest("/api/agents", {
    method: "POST",
    body: {
      name,
      role,
      description,
      instructions,
      status: "ready",
      accent: "violet",
      modelPolicy: "openai_fast",
      autonomy,
      approvalPolicy,
      memoryScope: "session",
      skillIds: [],
      toolIds,
    },
  });
  assert(response.agent?.id, "Agent creation returned no id.");
  assert(response.agent.tenantId === tenantId, "Created agent escaped its tenant.");
  createdAgentIds.push(response.agent.id);
  return response.agent.id;
}

async function agentRequest({ agentId, requestId, mode, message }) {
  const response = await rawRequest("/api/agent", {
    method: "POST",
    timeoutMs: 240_000,
    extraHeaders: { "idempotency-key": requestId },
    body: {
      messages: [{ role: "user", content: message }],
      mode,
      strategy: "direct",
      agentId,
      requestId,
    },
  });
  const text = await readTextLimited(response, 4_000_000);
  assert(response.status === 200, `Agent request returned HTTP ${response.status}.`);
  assert(
    (response.headers.get("content-type") || "").includes("text/event-stream"),
    "Agent response was not an SSE stream.",
  );
  const events = parseSse(text);
  const error = events.find((event) => event.type === "error");
  assert(!error, `Agent stream failed: ${safeText(error?.message || "unknown")}.`);
  return events;
}

async function waitForRun(runId, approvedExecutionId) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const detail = await jsonRequest(
      `/api/runs/${encodeURIComponent(runId)}?replay=true`,
    );
    if (["completed", "failed", "canceled"].includes(detail.run?.status)) {
      return detail;
    }
    if (
      detail.run?.status === "waiting_approval" &&
      detail.run?.waitingApproval?.executionId !== approvedExecutionId
    ) {
      throw new Error("Approval canary requested an unexpected second approval.");
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the approved run continuation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function jsonRequest(path, options = {}) {
  const response = await rawRequest(path, options);
  const text = await readTextLimited(response, 2_000_000);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned invalid JSON.`);
  }
  assert(
    response.status >= 200 && response.status < 300,
    `${path} returned HTTP ${response.status}: ${safeText(body.error || body.message || "request failed")}.`,
  );
  return body;
}

async function rawRequest(path, options = {}) {
  const headers = new Headers(requestHeaders);
  headers.set("accept", options.accept || "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(options.extraHeaders || {})) {
    headers.set(key, value);
  }
  return fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
}

async function readTextLimited(response, limit) {
  const text = await response.text();
  if (text.length > limit) throw new Error("Production response exceeded its bound.");
  return text;
}

function parseSse(text) {
  return text
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return [];
      try {
        return [JSON.parse(data)];
      } catch {
        throw new Error("Agent stream contained invalid SSE JSON.");
      }
    });
}

function oneEvent(events, type) {
  const matches = events.filter((event) => event.type === type);
  assert(matches.length === 1, `Expected exactly one ${type} event.`);
  return matches[0];
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeText(value) {
  return String(value).replace(/[\r\n<>]/g, " ").slice(0, 500);
}
