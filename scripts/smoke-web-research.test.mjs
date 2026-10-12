import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  researchEventDiagnostics,
  RESEARCH_REPORT_BUDGET,
  RESEARCH_REPORT_PROMPT,
  runSmokeWebResearch,
  smokeConfig,
  verifyResearchEvents,
  verifyResearchReportEvents,
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
const reportSources = [
  "https://docs.python.org/3/library/urllib.request.html",
  "https://nodejs.org/api/globals.html",
].map((url) => ({ kind: "web", url, citationId: `web:${createHash("sha256").update(url).digest("hex").slice(0, 16)}` }));

function reportEvents() {
  const explanation = "A useful client comparison distinguishes transport errors from HTTP status responses and describes redirect policies separately from timeout controls. Applications need explicit limits appropriate to their runtime and must check the documented behavior before relying on an implicit default. The source excerpts explain observable behavior, while version differences and unexamined pages remain limitations of this bounded research report.";
  return [
    { type: "run", runId: "mock-report-run" },
    ...["web.search", "web.search", "web.search", "web.read", "web.read"].map((toolId, index) => ({
      type: "tool", toolId, status: "executed", riskLevel: 0, dryRun: false,
      executionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    })),
    {
      type: "done",
      response: ["Executive summary", "Detailed comparison", "Practical recommendations", "Limitations and sources"]
        .map((title) => `## ${title}\n\n${explanation} ${explanation} [${reportSources[0].citationId}] [${reportSources[1].citationId}]`).join("\n\n"),
      grounding: { status: "missing", invalidIds: [], citedIds: reportSources.map((source) => source.citationId), sources: reportSources },
    },
  ];
}

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

async function withMockServer({ noSources = false, reportMode = false, researchEvents } = {}, callback) {
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
      assert.deepEqual(body.toolIds, reportMode ? ["web.search", "web.read"] : ["web.search"]);
      if (reportMode) {
        assert.match(body.instructions, /detailed structured report/);
        assert.doesNotMatch(body.instructions, /concisely/);
      }
      return json(201, { agent: { id: "mock-agent", tenantId } });
    }
    if (requestPath === "/api/agent" && method === "POST") {
      assert.equal(body.mode, "research");
      assert.equal(body.strategy, "direct");
      assert.equal(body.contextScope, "none");
      assert.equal(body.requireReadOnlyAgent, true);
      assert.equal(body.agentId, "mock-agent");
      assert.deepEqual(body.budgets, reportMode ? RESEARCH_REPORT_BUDGET : {
        modelTurns: 6, tokens: 64_000, costMicrousd: 500_000,
        wallTimeMs: 240_000, toolCalls: 3, browserActions: 0,
        agents: 2, fanOut: 1, retries: 0, replans: 0,
      });
      assert.ok(body.budgets.agents > 0 && body.budgets.fanOut > 0);
      assert.equal(headers.get("idempotency-key"), body.requestId);
      if (reportMode) {
        assert.equal(body.messages[0].content, RESEARCH_REPORT_PROMPT);
        return sse(researchEvents || reportEvents());
      }
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

test("report mode checks multi-source read receipts and substantial report structure without logging text", async () => {
  await withMockServer({ reportMode: true }, async (requests) => {
    const logs = [];
    const result = await runSmokeWebResearch(environment({ SMOKE_RESEARCH_REPORT: "1" }), (line) => logs.push(line));
    assert.equal(result.status, "PASS");
    assert.equal(result.mode, "web-search-and-research-report");
    assert.equal(result.research.webToolExecutions, 3);
    assert.equal(result.research.webReadExecutions, 2);
    assert.equal(result.research.citedSourceCount, 2);
    assert.equal(result.research.reportSectionCount, 4);
    assert.ok(result.research.reportWordCount >= 400);
    assert.deepEqual(result.direct, { sourceCount: 1 });
    assert.equal(result.agentPurged, true);
    assert.equal(result.signedOut, true);
    assert.equal(requests.filter(({ path }) => path === "/api/agent").length, 1);
    assert.equal(requests.at(-1).path, "/api/auth/logout");
    const output = logs.join("\n");
    for (const privateValue of [actorId, password, sessionToken, "A useful client comparison", ...reportSources.map((source) => source.url)]) {
      assert.equal(output.includes(privateValue), false);
    }
    const diagnostic = researchEventDiagnostics(reportEvents());
    assert.equal(diagnostic.toolStatuses["web.read:executed"], 2);
  });
});

test("report mode rejects short search-result answers and preserves purge/logout without retry", async () => {
  const events = reportEvents();
  events.at(-1).response = `## Summary\nA search result [${reportSources[0].citationId}].\n## Findings\nShort answer.\n## Limits\nNothing more.\n## Sources\n[${reportSources[1].citationId}].`;
  await withMockServer({ reportMode: true, researchEvents: events }, async (requests) => {
    await assert.rejects(runSmokeWebResearch(environment({ SMOKE_RESEARCH_REPORT: "1" }), () => undefined), /too short/);
    assert.equal(requests.filter(({ path }) => path === "/api/agent").length, 1);
    assert.equal(requests.filter(({ path, method }) => path === `/api/trash/${encodedTrashId}/purge` && method === "DELETE").length, 1);
    assert.equal(requests.at(-1).path, "/api/auth/logout");
  });
});

test("report mode rejects search-only, malformed, dry-run, and duplicated read receipts", () => {
  assert.throws(() => verifyResearchReportEvents(reportEvents().filter((event) => event.toolId !== "web.read")), /two successful web.read/);
  for (const patch of [
    { status: "running" }, { status: "dry_run" }, { status: "executed", dryRun: true },
    { status: "executed", dryRun: undefined }, { executionId: "invented" },
    { executionId: undefined }, { riskLevel: 2 }, { status: undefined },
  ]) {
    const events = reportEvents();
    Object.assign(events.find((event) => event.toolId === "web.read"), patch);
    assert.throws(() => verifyResearchReportEvents(events), /two successful web.read|malformed or unexecuted/);
  }
  const repeated = reportEvents();
  repeated[5].executionId = repeated[4].executionId;
  assert.throws(() => verifyResearchReportEvents(repeated), /repeated a tool execution/);
  const twoSearches = reportEvents();
  twoSearches.splice(1, 1);
  assert.throws(() => verifyResearchReportEvents(twoSearches), /three executed web.search/);
});

test("report mode requires citation IDs bound to URLs and actual answer text", () => {
  const changedUrl = reportEvents();
  changedUrl.at(-1).grounding.sources = changedUrl.at(-1).grounding.sources.map((source, index) => index ? { ...source, url: "https://example.com/unrelated" } : source);
  assert.throws(() => verifyResearchReportEvents(changedUrl), /not bound/);
  const absent = reportEvents();
  absent.at(-1).response = absent.at(-1).response.replaceAll(`[${reportSources[1].citationId}]`, "");
  assert.throws(() => verifyResearchReportEvents(absent), /not bound/);
  const oneSource = reportEvents();
  oneSource.at(-1).grounding = { ...oneSource.at(-1).grounding, citedIds: [reportSources[0].citationId], sources: [reportSources[0]] };
  assert.throws(() => verifyResearchReportEvents(oneSource), /two distinct public URLs/);
});

test("report mode tolerates unavailable pages only after enough successful reads", () => {
  const events = reportEvents();
  events.splice(-1, 0, { type: "tool", toolId: "web.read", status: "failed", dryRun: false,
    riskLevel: 0, executionId: "00000000-0000-4000-8000-000000000099" });
  assert.equal(verifyResearchReportEvents(events).webReadExecutions, 2);
  assert.equal(verifyResearchReportEvents(events).failedWebReadAttempts, 1);
});

test("report mode accepts recovered recorded search failures and reports their counts while quick smoke stays strict", () => {
  const events = reportEvents();
  for (let index = 1; index <= 3; index += 1) {
    events.splice(1, 0, { type: "tool", toolId: "web.search", status: "failed", dryRun: false,
      riskLevel: 0, executionId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      summary: "Request was aborted." });
  }
  const receipt = verifyResearchReportEvents(events);
  assert.equal(receipt.webToolExecutions, 3);
  assert.equal(receipt.webReadExecutions, 2);
  assert.equal(receipt.failedWebSearchAttempts, 3);
  assert.equal(receipt.failedWebReadAttempts, 0);
  assert.throws(() => verifyResearchEvents(events), /did not remain an approved live read/);
  const insufficient = events.filter((event) => event.executionId !== "00000000-0000-4000-8000-000000000001");
  assert.throws(() => verifyResearchReportEvents(insufficient), /three executed web.search/);
});

test("recovered report still rejects missing, malformed, or unsafe failed search and read receipts", () => {
  for (const toolId of ["web.search", "web.read"]) {
    for (const patch of [
      { executionId: undefined }, { executionId: "malformed" }, { dryRun: undefined },
      { dryRun: true }, { riskLevel: undefined }, { riskLevel: 2 },
      { status: "blocked" }, { status: "approval_required" }, { status: "dry_run" },
      { status: "rejected" }, { status: undefined }, { toolId: "http.request" },
    ]) {
      const events = reportEvents();
      events.splice(1, 0, { type: "tool", toolId, status: "failed", dryRun: false,
        riskLevel: 0, executionId: "00000000-0000-4000-8000-000000000101", ...patch });
      assert.throws(() => verifyResearchReportEvents(events), /malformed or unexecuted|did not remain an approved live read|outside its public read-only allowlist/);
    }
  }
});

test("report receipts accept exact canonical idempotent IDs while rejecting malformed digest identities", () => {
  const canonical = reportEvents();
  for (const event of canonical.filter((item) => item.type === "tool")) {
    event.executionId = `idem_${createHash("sha256").update(`tenant-fixture\u0000${event.executionId}`).digest("hex")}`;
  }
  assert.equal(verifyResearchReportEvents(canonical).webToolExecutions, 3);
  for (const malformed of [
    `idem_${"a".repeat(63)}`, `idem_${"a".repeat(65)}`, `idem_${"g".repeat(64)}`,
    `idem_${"A".repeat(64)}`, `IDEM_${"a".repeat(64)}`, `tool_${"a".repeat(64)}`,
    ` ${canonical[1].executionId}`, `${canonical[1].executionId}\n`,
  ]) {
    const events = reportEvents();
    events[1].executionId = malformed;
    assert.throws(() => verifyResearchReportEvents(events), /malformed or unexecuted/);
  }
  canonical[2].executionId = canonical[1].executionId;
  assert.throws(() => verifyResearchReportEvents(canonical), /repeated a tool execution/);
});

test("report acceptance requires sections and does not count a code dump as report prose", () => {
  const unstructured = reportEvents();
  unstructured.at(-1).response = unstructured.at(-1).response.replaceAll("## ", "");
  assert.throws(() => verifyResearchReportEvents(unstructured), /four Markdown sections/);
  const codeDump = reportEvents();
  codeDump.at(-1).response = `## Summary\n[${reportSources[0].citationId}]\n## Findings\n[${reportSources[1].citationId}]\n## Limits\nUnverified.\n## Sources\n\`\`\`\n${"code token ".repeat(400)}\n\`\`\``;
  assert.throws(() => verifyResearchReportEvents(codeDump), /too short/);
});

test("report mode rejects conflicting quick-only flags before authentication", () => {
  assert.throws(() => smokeConfig(environment({ SMOKE_RESEARCH_REPORT: "1", SMOKE_WEB_SEARCH_ONLY: "1" })), /cannot be combined/);
});
