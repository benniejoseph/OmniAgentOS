#!/usr/bin/env node
/**
 * Authenticated, bounded live check of governed web.search and a read-only
 * Research Agent. Run against the canonical origin or an approved staged
 * Vercel origin. Two paid requests are issued at most: one direct tool POST
 * and, unless SMOKE_WEB_SEARCH_ONLY=1, one Agent POST. The Agent may make
 * multiple model/tool calls within the fixed request budget.
 *
 * Required: BASE_URL, EXPECTED_REVISION, SMOKE_PAID_AGENT_EMAIL,
 * SMOKE_PAID_AGENT_PASSWORD. Optional: SMOKE_TENANT_ID, SMOKE_ACTOR_ID,
 * SMOKE_INTERNAL_AUTH_SECRET, VERCEL_AUTOMATION_BYPASS_SECRET.
 * This script never retries either paid POST or prints answer text.
 */

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assert,
  createOperatorSession,
  operatorTarget,
  readTextLimited,
  requiredEnvironment,
} from "./operator-session.mjs";

const PUBLIC_DOCS_QUERY =
  "Find the official OpenAI documentation for the Responses API web search tool.";
const RESEARCH_PROMPT =
  "Use live web search to find the official OpenAI Responses API web search documentation. " +
  "Give one concise factual sentence and cite at least one source using its [web:...] citation ID.";
const MISSING_SUMMARY =
  "Live web search completed, but no summary text was returned.";
const TRASH_ID = /^trash:[0-9a-f-]{36}$/;
const RESEARCH_BUDGET = Object.freeze({
  modelTurns: 6,
  tokens: 64_000,
  costMicrousd: 500_000,
  wallTimeMs: 240_000,
  toolCalls: 3,
  browserActions: 0,
  agents: 2,
  fanOut: 1,
  retries: 0,
  replans: 0,
});

export function smokeConfig(env = process.env) {
  return {
    ...operatorTarget(requiredEnvironment(env, "BASE_URL")),
    expectedRevision: requiredEnvironment(env, "EXPECTED_REVISION"),
    email: requiredEnvironment(env, "SMOKE_PAID_AGENT_EMAIL"),
    password: requiredEnvironment(env, "SMOKE_PAID_AGENT_PASSWORD", {
      preserveWhitespace: true,
    }),
    expectedTenantId: env.SMOKE_TENANT_ID?.trim() || undefined,
    expectedActorId: env.SMOKE_ACTOR_ID?.trim() || undefined,
    syntheticSecret: (
      env.SMOKE_INTERNAL_AUTH_SECRET ||
      env.OMNIAGENT_INTERNAL_AUTH_SECRET ||
      ""
    ).trim(),
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "",
    webSearchOnly: env.SMOKE_WEB_SEARCH_ONLY === "1",
  };
}

/** Strip credentials, search parameters, fragments, and non-public hosts. */
export function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const hasUserInfo = [url.username, url.password].some(Boolean);
    if (
      url.protocol !== "https:" ||
      hasUserInfo || url.port ||
      !hostname.includes(".") || isIP(hostname) ||
      hostname === "localhost" || hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) return null;
    const safe = `${url.origin}${url.pathname}`;
    return safe.length <= 300 ? safe : null;
  } catch {
    return null;
  }
}

function sourceUrls(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((item) => safeSourceUrl(item?.url)).filter(Boolean))]
    .slice(0, 5);
}

export function verifyDirectSearch(body) {
  assert(body?.record?.status === "executed",
    "Governed web.search was not executed.");
  const result = body.result;
  assert(typeof result?.summary === "string" &&
    result.summary.trim() && result.summary !== MISSING_SUMMARY,
  "Governed web.search returned no substantive summary.");
  assert(Array.isArray(result.sources) && result.sources.length > 0 &&
    result.sourceCount === result.sources.length,
  "Governed web.search returned no structured sources.");
  const urls = sourceUrls(result.sources);
  assert(urls.length > 0,
    "Governed web.search returned no safe public source URL.");
  return { sourceCount: result.sourceCount, sourceUrls: urls };
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      assert(event && typeof event === "object" && !Array.isArray(event),
        "Agent stream contained an invalid SSE event.");
      events.push(event);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Agent stream contained invalid SSE JSON.");
      }
      throw error;
    }
  }
  return events;
}

/** Only fixed labels and counts; never answer text, prompts, tool output, or URLs. */
export function researchEventDiagnostics(events) {
  const allowedTypes = new Set([
    "run", "status", "tool", "memory", "model", "delta", "done",
    "error", "canceled", "waiting_approval", "clarification", "delegated",
    "budget_exhausted", "execution_target_retired",
  ]);
  const allowedToolStatuses = new Set([
    "running", "executed", "dry_run", "approval_required", "blocked", "failed",
  ]);
  const eventTypes = {};
  const toolStatuses = {};
  for (const event of events) {
    const type = allowedTypes.has(event?.type) ? event.type : "other";
    eventTypes[type] = (eventTypes[type] || 0) + 1;
    if (type === "tool") {
      const tool = event.toolId === "web.search" ? "web.search" : "other";
      const status = allowedToolStatuses.has(event.status) ? event.status : "other";
      const key = `${tool}:${status}`;
      toolStatuses[key] = (toolStatuses[key] || 0) + 1;
    }
  }
  const done = events.filter((event) => event?.type === "done");
  const grounding = done.at(-1)?.grounding;
  const citedIds = Array.isArray(grounding?.citedIds) ? grounding.citedIds : [];
  const sources = Array.isArray(grounding?.sources) ? grounding.sources : [];
  const groundingStatuses = new Set([
    "verified", "not_required", "missing", "invalid",
  ]);
  const allowedBudgetDimensions = new Set([
    "modelTurns", "tokens", "costMicrousd", "wallTimeMs", "toolCalls",
    "browserActions", "agents", "fanOut", "retries", "replans",
  ]);
  const safeCounter = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
      ? value : null;
  const budgetExhaustions = events
    .filter((event) => event?.type === "budget_exhausted")
    .slice(0, 3)
    .map((event) => ({
      dimension: allowedBudgetDimensions.has(event.dimension)
        ? event.dimension : "other",
      limit: safeCounter(event.limit),
      attempted: safeCounter(event.attempted),
    }));
  return {
    eventCount: events.length,
    eventTypes,
    toolStatuses,
    doneCount: done.length,
    doneGrounding: {
      status: groundingStatuses.has(grounding?.status)
        ? grounding.status : "unknown",
      citedCount: citedIds.length,
      webCitedCount: citedIds.filter((id) =>
        typeof id === "string" && id.startsWith("web:")).length,
      sourceCount: sources.length,
      webSourceCount: sources.filter((source) => source?.kind === "web").length,
    },
    budgetExhaustions,
  };
}

export function verifyResearchEvents(events) {
  assert(Array.isArray(events), "Agent events are invalid.");
  const terminalFailures = new Set([
    "error", "canceled", "waiting_approval", "clarification", "delegated",
    "budget_exhausted", "execution_target_retired",
  ]);
  assert(!events.some((event) => terminalFailures.has(event.type)),
    "Research stream did not finish as a direct read-only run.");
  const webToolEvents = events.filter((event) =>
    event.type === "tool" && event.toolId === "web.search");
  const webExecuted = webToolEvents.filter((event) =>
    event.status === "executed" && event.dryRun !== true);
  assert(webExecuted.length > 0,
    "Research stream recorded no executed web.search tool.");
  assert(!webToolEvents.some((event) =>
    ["failed", "blocked", "approval_required", "dry_run"].includes(event.status)),
  "Research web.search did not remain an approved live read.");
  const done = events.filter((event) => event.type === "done");
  assert(done.length === 1 && typeof done[0].response === "string" &&
    done[0].response.trim(),
  "Research stream did not complete exactly once with an answer.");
  const grounding = done[0].grounding;
  const citedIds = Array.isArray(grounding?.citedIds)
    ? grounding.citedIds.filter((id) => typeof id === "string" && id.startsWith("web:"))
    : [];
  assert(citedIds.length > 0,
    "Research answer contained no web citation.");
  assert(grounding?.status !== "invalid",
    "Research answer contained an invalid citation.");
  const cited = new Set(citedIds);
  const citedSources = Array.isArray(grounding?.sources)
    ? grounding.sources.filter((source) =>
        source?.kind === "web" && cited.has(source.citationId))
    : [];
  const urls = sourceUrls(citedSources);
  assert(urls.length > 0,
    "Research web citation had no safe public source URL.");
  return {
    webToolExecutions: webExecuted.length,
    webCitationCount: citedIds.length,
    sourceUrls: urls,
  };
}

export async function runSmokeWebResearch(env = process.env, log = console.log) {
  const config = smokeConfig(env);
  const session = createOperatorSession({
    baseUrl: config.baseUrl,
    origin: config.origin,
    email: config.email,
    password: config.password,
    expectedTenantId: config.expectedTenantId,
    expectedActorId: config.expectedActorId,
    syntheticSecret: config.syntheticSecret,
    syntheticSource: "web-research-verification",
    bypassSecret: config.bypassSecret,
  });
  const { jsonRequest, rawRequest, safeText } = session;
  const marker = randomUUID();
  const suffix = marker.replaceAll("-", "").slice(0, 12);
  let agentId;
  let agentPurged = false;
  let signedOut = false;
  let primaryFailure;
  let cleanupFailure;
  let signOutFailure;
  let result;

  try {
    const health = await jsonRequest("/api/health");
    assert(health.status === "healthy" &&
      health.revision === config.expectedRevision,
    "Deployment health or revision did not match EXPECTED_REVISION.");
    log("stage health pinned");

    const identity = await session.signIn();
    log("stage authenticated session");

    // One paid, governed tool call. Never retry after an ambiguous response.
    const direct = await jsonRequest("/api/tools/execute", {
      method: "POST",
      timeoutMs: 120_000,
      body: {
        toolId: "web.search",
        dryRun: false,
        input: {
          query: PUBLIC_DOCS_QUERY,
          limit: 5,
          searchContextSize: "low",
        },
      },
    });
    const directReceipt = verifyDirectSearch(direct);
    log(`stage governed web.search executed; ${directReceipt.sourceCount} sources`);

    let researchReceipt;
    if (!config.webSearchOnly) {
      const created = await jsonRequest("/api/agents", {
        method: "POST",
        body: {
          name: `Web Research Smoke ${suffix}`,
          role: "Public documentation research verifier",
          description: `Temporary web Research smoke agent ${marker}`,
          instructions:
            "Use only web.search for this public documentation request. " +
            "Answer concisely with at least one exact [web:...] citation. " +
            "Do not use private account data or other tools.",
          status: "ready",
          accent: "violet",
          modelPolicy: "openai_fast",
          autonomy: "assist",
          approvalPolicy: "read_only",
          memoryScope: "session",
          skillIds: [],
          toolIds: ["web.search"],
        },
      }, 201);
      agentId = created.agent?.id;
      assert(typeof agentId === "string" && agentId &&
        created.agent.tenantId === identity.tenantId,
      "Temporary read-only Agent was not created in the signed-in tenant.");
      log("stage temporary read-only Agent ready");

      // One paid Agent request, with no retry. The server enforces this exact
      // read-only principal and prevents durable memory formation.
      const requestId = `web_research_smoke:${marker}`;
      const response = await rawRequest("/api/agent", {
        method: "POST",
        timeoutMs: 270_000,
        accept: "text/event-stream",
        headers: { "idempotency-key": requestId },
        body: {
          messages: [{ role: "user", content: RESEARCH_PROMPT }],
          mode: "research",
          strategy: "direct",
          contextScope: "none",
          agentId,
          requestId,
          requireReadOnlyAgent: true,
          budgets: RESEARCH_BUDGET,
        },
      });
      assert(response.status === 200,
        `Research Agent returned HTTP ${response.status}.`);
      assert((response.headers.get("content-type") || "")
        .includes("text/event-stream"),
      "Research Agent did not return SSE.");
      const events = parseSse(await readTextLimited(response, 4_000_000));
      log(`stage Research event metadata ${JSON.stringify(researchEventDiagnostics(events))}`);
      researchReceipt = verifyResearchEvents(events);
      log(`stage Research SSE verified; ${researchReceipt.webCitationCount} web citations`);
    }

    const closingHealth = await jsonRequest("/api/health");
    assert(closingHealth.status === "healthy" &&
      closingHealth.revision === config.expectedRevision,
    "Deployment revision changed during verification.");
    result = {
      status: "PASS",
      revision: health.revision,
      mode: config.webSearchOnly ? "web-search-only" : "web-search-and-research",
      direct: directReceipt,
      ...(researchReceipt ? { research: researchReceipt } : {}),
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (agentId) {
      try {
        await removeAgent(jsonRequest, agentId);
        agentPurged = true;
        log("stage temporary Agent purged");
      } catch (error) {
        cleanupFailure = error;
      }
    }
    try {
      await session.signOut();
      signedOut = true;
      log("stage signed out");
    } catch (error) {
      signOutFailure = error;
    }
  }

  if (primaryFailure || cleanupFailure || signOutFailure) {
    const reasons = [
      [primaryFailure, ""],
      [cleanupFailure, "Cleanup: "],
      [signOutFailure, "Sign-out: "],
    ].filter(([error]) => error)
      .map(([error, label]) =>
        label + safeText(error instanceof Error ? error.message : String(error)));
    throw new Error(reasons.join(" "));
  }
  const receipt = { ...result, agentPurged, signedOut };
  log(JSON.stringify(receipt));
  return receipt;
}

async function removeAgent(jsonRequest, id) {
  const agentPath = `/api/agents/${encodeURIComponent(id)}`;
  const trashPreview = await jsonRequest(`${agentPath}?mode=trash-preview`);
  assert(trashPreview.preview?.action === "trash" &&
    trashPreview.preview?.resourceType === "custom_agent" &&
    trashPreview.preview?.resourceId === id,
  "Agent trash preview does not match the temporary Agent.");
  const trashed = await jsonRequest(agentPath, {
    method: "DELETE", body: { preview: trashPreview.preview },
  });
  assert(trashed.movedToTrash === true &&
    TRASH_ID.test(String(trashed.trash?.trashId)) &&
    trashed.trash?.resourceId === id,
  "Temporary Agent was not moved to Trash.");
  const trashId = trashed.trash.trashId;
  const purgePath = `/api/trash/${encodeURIComponent(trashId)}/purge`;
  const purgePreview = await jsonRequest(purgePath);
  assert(purgePreview.preview?.action === "purge" &&
    purgePreview.preview?.trashId === trashId,
  "Trash purge preview does not match the temporary Agent.");
  const purged = await jsonRequest(purgePath, {
    method: "DELETE", body: { preview: purgePreview.preview },
  });
  assert(purged.trash?.trashId === trashId &&
    purged.trash?.state === "purged",
  "Temporary Agent was not purged.");
}

if (process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runSmokeWebResearch().catch((error) => {
    console.error(`FAIL web/research smoke: ${error instanceof Error
      ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  });
}
