import assert from "node:assert/strict";
import test from "node:test";
import {
  researchEventDiagnostics,
  runSmokeWebResearch,
} from "./smoke-web-research.mjs";

const revision = "70b1522a886383775636377864e378cab08c78a8";
const baseUrl = "https://asael.bennierichard.com";
const tenantId = "tenant-smoke";
const actorId = "owner@example.test";
const password = " mock password ";
const sessionToken = "mock-session-secret";
const trashId = "trash:00000000-0000-4000-8000-000000000000";
const encodedTrashId = encodeURIComponent(trashId);
const sourceUrl =
  "https://platform.openai.com/docs/guides/tools-web-search?private=omit";
const citationId = "web:example";

function environment(extra = {}) {
  return {
    BASE_URL: baseUrl,
    EXPECTED_REVISION: revision,
    SMOKE_PAID_AGENT_EMAIL: actorId,
    SMOKE_PAID_AGENT_PASSWORD: password,
    SMOKE_TENANT_ID: tenantId,
    SMOKE_ACTOR_ID: actorId,
    SMOKE_INTERNAL_AUTH_SECRET: "mock-synthetic-secret",
    ...extra,
  };
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(events) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function withMockServer({ noSources = false } = {}, callback) {
  const oldFetch = globalThis.fetch;
  const requests = [];
  let authenticated = false;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    const method = init.method || "GET";
    const requestPath = target.pathname + target.search;
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: requestPath, body, headers });
    assert.equal(target.origin, baseUrl);
    assert.equal(init.redirect, "manual");
    assert.equal(headers.get("origin"), baseUrl);
    assert.equal(headers.get("cookie"),
      authenticated ? `__Host-asael_session=${sessionToken}` : null);
    if (method !== "GET") {
      assert.ok(headers.get("idempotency-key"));
    }
    if (requestPath === "/api/health" && method === "GET") {
      return json(200, { status: "healthy", revision });
    }
    if (requestPath === "/api/auth/login" && method === "POST") {
      assert.deepEqual(body, { email: actorId, password });
      authenticated = true;
      return json(200, {
        authenticated: true,
        context: { source: "session", tenantId, actorId },
      }, { "set-cookie": `__Host-asael_session=${sessionToken}; Path=/; Secure` });
    }
    if (requestPath === "/api/tools/execute" && method === "POST") {
      assert.equal(body.toolId, "web.search");
      assert.equal(body.dryRun, false);
      assert.match(body.input.query, /official OpenAI documentation/);
      return json(200, {
        record: { status: "executed", dryRun: false },
        result: {
          summary: "The official documentation describes web search.",
          sources: noSources ? [] : [{ url: sourceUrl, citationId }],
          sourceCount: noSources ? 0 : 1,
        },
      });
    }
    if (requestPath === "/api/agents" && method === "POST") {
      assert.equal(body.approvalPolicy, "read_only");
      assert.equal(body.memoryScope, "session");
      assert.deepEqual(body.toolIds, ["web.search"]);
      return json(201, { agent: { id: "mock-agent", tenantId } });
    }
    if (requestPath === "/api/agent" && method === "POST") {
      assert.equal(body.mode, "research");
      assert.equal(body.strategy, "direct");
      assert.equal(body.contextScope, "none");
      assert.equal(body.requireReadOnlyAgent, true);
      assert.equal(body.agentId, "mock-agent");
      assert.deepEqual(body.budgets, {
        modelTurns: 6, tokens: 64_000, costMicrousd: 500_000,
        wallTimeMs: 240_000, toolCalls: 3, browserActions: 0,
        agents: 2, fanOut: 1, retries: 0, replans: 0,
      });
      assert.ok(body.budgets.agents > 0 && body.budgets.fanOut > 0);
      assert.equal(headers.get("idempotency-key"), body.requestId);
      return sse([
        { type: "run", runId: "mock-run" },
        { type: "tool", toolId: "web.search", status: "running" },
        { type: "tool", toolId: "web.search", status: "executed", dryRun: false },
        {
          type: "done",
          response: `Official docs are available [${citationId}].`,
          grounding: {
            status: "verified",
            citedIds: [citationId],
            sources: [{ kind: "web", citationId, url: sourceUrl }],
          },
        },
      ]);
    }
    if (requestPath === "/api/agents/mock-agent?mode=trash-preview" &&
        method === "GET") {
      return json(200, {
        preview: {
          action: "trash", resourceType: "custom_agent", resourceId: "mock-agent",
        },
      });
    }
    if (requestPath === "/api/agents/mock-agent" && method === "DELETE") {
      assert.equal(body.preview.resourceId, "mock-agent");
      return json(200, {
        movedToTrash: true,
        trash: { trashId, resourceId: "mock-agent" },
      });
    }
    if (requestPath === `/api/trash/${encodedTrashId}/purge` && method === "GET") {
      return json(200, { preview: { action: "purge", trashId } });
    }
    if (requestPath === `/api/trash/${encodedTrashId}/purge` && method === "DELETE") {
      assert.equal(body.preview.trashId, trashId);
      return json(200, { trash: { trashId, state: "purged" } });
    }
    if (requestPath === "/api/auth/logout" && method === "POST") {
      authenticated = false;
      return json(200, { authenticated: false });
    }
    throw new Error(`Unexpected mock request: ${method} ${requestPath}`);
  };
  try {
    await callback(requests);
    assert.equal(authenticated, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

test("checks direct search and read-only Research, purges the Agent, and logs out", async () => {
  await withMockServer({}, async (requests) => {
    const logs = [];
    const result = await runSmokeWebResearch(environment(), (line) => logs.push(line));
    assert.equal(result.status, "PASS");
    assert.equal(result.direct.sourceCount, 1);
    assert.deepEqual(result.direct.sourceUrls,
      ["https://platform.openai.com/docs/guides/tools-web-search"]);
    assert.equal(result.research.webCitationCount, 1);
    assert.equal(result.agentPurged, true);
    assert.equal(result.signedOut, true);
    assert.deepEqual(
      requests.filter(({ path }) =>
        path === "/api/tools/execute" || path === "/api/agent")
        .map(({ path }) => path),
      ["/api/tools/execute", "/api/agent"],
    );
    assert.equal(requests.at(-1).path, "/api/auth/logout");
    const metadataLine = logs.find((line) =>
      line.startsWith("stage Research event metadata "));
    assert.ok(metadataLine);
    const metadata = JSON.parse(metadataLine.slice(
      "stage Research event metadata ".length));
    assert.equal(metadata.eventTypes.done, 1);
    assert.equal(metadata.toolStatuses["web.search:executed"], 1);
    assert.equal(metadata.doneGrounding.webCitedCount, 1);
    assert.equal(metadata.doneGrounding.webSourceCount, 1);
    assert.equal(metadataLine.includes("Official docs are available"), false);
    assert.equal(metadataLine.includes(sourceUrl), false);
    const output = logs.join("\n");
    for (const secret of [actorId, password, sessionToken, "mock-synthetic-secret"]) {
      assert.equal(output.includes(secret), false);
    }
  });
});

test("Research diagnostics expose only fixed labels and counts", () => {
  const diagnostic = researchEventDiagnostics([
    { type: "error", message: "PRIVATE_ERROR_DETAIL" },
    { type: "budget_exhausted", dimension: "tokens", limit: 16_000,
      attempted: 17_250, message: "PRIVATE_BUDGET_MESSAGE" },
    { type: "budget_exhausted", dimension: "PRIVATE_DIMENSION", limit: -1,
      attempted: "PRIVATE_NUMBER", message: "PRIVATE_BUDGET_MESSAGE" },
    { type: "tool", toolId: "PRIVATE_TOOL_ID", status: "executed",
      summary: "PRIVATE_TOOL_RESULT" },
    { type: "done", response: "PRIVATE_ANSWER", grounding: {
      status: "missing",
      citedIds: ["web:private-citation"],
      sources: [{ kind: "web", url: "https://example.com/private" }],
    } },
  ]);
  assert.equal(diagnostic.eventTypes.error, 1);
  assert.equal(diagnostic.toolStatuses["other:executed"], 1);
  assert.equal(diagnostic.doneGrounding.webCitedCount, 1);
  assert.deepEqual(diagnostic.budgetExhaustions, [
    { dimension: "tokens", limit: 16_000, attempted: 17_250 },
    { dimension: "other", limit: null, attempted: null },
  ]);
  const output = JSON.stringify(diagnostic);
  for (const privateValue of ["PRIVATE_ERROR_DETAIL", "PRIVATE_TOOL_ID",
    "PRIVATE_TOOL_RESULT", "PRIVATE_ANSWER", "PRIVATE_BUDGET_MESSAGE",
    "PRIVATE_DIMENSION", "PRIVATE_NUMBER", "private-citation",
    "example.com/private"]) {
    assert.equal(output.includes(privateValue), false);
  }
});

test("web-search-only mode makes one paid request and no temporary Agent", async () => {
  await withMockServer({}, async (requests) => {
    const result = await runSmokeWebResearch(
      environment({ SMOKE_WEB_SEARCH_ONLY: "1" }), () => undefined,
    );
    assert.equal(result.mode, "web-search-only");
    assert.equal(result.agentPurged, false);
    assert.equal(requests.some(({ path }) => path === "/api/agents"), false);
    assert.equal(requests.some(({ path }) => path === "/api/agent"), false);
    assert.equal(requests.at(-1).path, "/api/auth/logout");
  });
});

test("missing sources fail without retrying the paid call and still log out", async () => {
  await withMockServer({ noSources: true }, async (requests) => {
    await assert.rejects(
      runSmokeWebResearch(environment(), () => undefined),
      /Governed web.search returned no structured sources/,
    );
    assert.equal(requests.filter(({ path }) => path === "/api/tools/execute").length, 1);
    assert.equal(requests.some(({ path }) => path === "/api/agent"), false);
    assert.equal(requests.at(-1).path, "/api/auth/logout");
  });
});
