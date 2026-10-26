/** Focused regressions for the agent review findings. No network or model calls. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeCapabilitySearchQuery, loadProgressiveAgentTools } from "@/lib/capabilities/toolbox";
import { getGovernedTools } from "@/lib/tools/registry";
import { reviewToolObservation } from "@/lib/orchestration/agent-runner";
import { AvailabilityWatchCheckSchema } from "@/lib/availability-watches/contracts";
import { buildClaimGroundingReport, buildWebCitationSources, verifyCitationSources } from "@/lib/rag/citations";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { delegateAgentTaskInputSchema } from "@/lib/delegation/runtime";
import { DYNAMIC_DELEGATION_LIFECYCLE_BUDGET, dynamicDelegationParentToolReservation } from "@/lib/delegation/runtime-policy";
import { durableSpecialistProfile } from "@/lib/subagents/profiles";
import { getAgentPerformance } from "@/lib/agents/performance";
import { createAgentRun, completeAgentRun } from "@/lib/runs/store";

const results: Record<string, unknown> = {};
let dataDir = "";

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "asael-agent-review-"));
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDir);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in offline review probes"); }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

it("retains requested capabilities in every clause", async () => {
  const prefix = "Read the existing Scout task and report its state, acceptance criteria, and recorded outcome. Read the saved watch and explain the checking method, notification readiness, existing delivery receipts and next check. ";
  const suffix = "Then use web.availability.inspect to check the exact public cinema source and compare the current morning showtimes.";
  const dependencies = { listNative: getGovernedTools, search: vi.fn(async () => ({ capabilities: [], query: "", total: 0, limit: 50, hasMore: false })), resolveMcp: vi.fn(async () => null), resolveOpenApi: vi.fn(async () => null) };
  const full = prefix + suffix;
  const compact = composeCapabilitySearchQuery(full);
  const selected = await loadProgressiveAgentTools({ query: compact, autonomousDelegation: true }, dependencies);
  const direct = await loadProgressiveAgentTools({ query: composeCapabilitySearchQuery(suffix, prefix), autonomousDelegation: true }, dependencies);
  results.capabilityAdmission = { fullLength: full.length, query: compact, queryLength: compact.length, selected: selected.definitions.map(t => t.id), requestedToolInQuery: compact.includes("web.availability.inspect"), selectedWhenNamedFirst: direct.definitions.map(t => t.id), schemaBytes: selected.schemaBytes };
  expect(compact).toContain(suffix);
  expect(selected.definitions.some(t => t.id === "web.availability.inspect")).toBe(true);
  expect(compact).toContain("web.availability.inspect");
  expect(direct.definitions.some(t => t.id === "web.availability.inspect")).toBe(true);
});

it("keeps readiness and pagination with forty schema-valid checks", () => {
  const at = "2026-10-18T08:00:00.000Z";
  const checks = Array.from({ length: 40 }, (_, i) => AvailabilityWatchCheckSchema.parse({ id: `availability-check:${i.toString(16).padStart(64, "0")}`, generation: 1, scheduledFor: at, state: "completed", startedAt: at, finishedAt: at, observation: { outcome: "not_listed", checkedAt: at, providerObservedAt: at, sourceUrl: "https://www.district.in/movies/pvr-vr-whitefield-road-bengaluru-CD1022272?fromdate=2026-10-19", sourceSha256: "a".repeat(64), providerCinemaName: "PVR VR Whitefield Road Bengaluru", matchingSessions: 0, matches: [], scope: "This District cinema page and selected date only; seats and prices may change before checkout." }, error: null, toolExecutionId: `test-read-${i}` }));
  const result = { watch: { id: `watch_${"a".repeat(48)}`, state: "active" }, checks, hasMore: true, readiness: { schemaVersion: 1, notificationsEnabled: true, browser: { eligibleDevices: 1 }, android: { eligibleDevices: 0 }, alertPolicy: { bypassQuietHours: true } } };
  const observation = reviewToolObservation({ record: { id: "diagnostic-watch-read", toolId: "app.watches.show", status: "executed", dryRun: false, approvalRequired: false }, result } as Parameters<typeof reviewToolObservation>[0]);
  let validJson = true; try { JSON.parse(observation.modelOutput); } catch { validJson = false; }
  results.watchProjection = { originalCharacters: JSON.stringify(result).length, deliveredCharacters: observation.modelOutput.length, validJson, readinessPreserved: observation.modelOutput.includes('"readiness"'), historyChecks: checks.length, truncated: observation.modelOutput.endsWith("… [truncated]") };
  expect(validJson).toBe(true);
  expect(observation.modelOutput.length).toBeLessThanOrEqual(8_000);
  expect(JSON.parse(observation.modelOutput).data.result.nextPage).toMatchObject({ id: result.watch.id, limit: 2 });
  expect(observation.modelOutput).toContain('"readiness"');
});

it("does not treat an unbound web snippet as verified evidence", async () => {
  const sources = buildWebCitationSources([{ url: "https://example.com/launch", title: "Launch notice", snippet: "The launch date is 19 October 2026." }], "2026-10-18T08:00:00.000Z");
  const response = `The launch date is 19 October 2026. [${sources[0].citationId}]`;
  const syntax = verifyCitationSources(response, sources);
  const grounding = await buildClaimGroundingReport({ runId: "offline-review", response, sources, executionScope: createExecutionScope({ tenantId: "offline-review", initiatingActorId: "review-owner", executingPrincipalType: "agent", executingPrincipalId: "atlas", correlationId: "offline-review", purpose: "agent.run.legacy" }), evaluatedAt: "2026-10-18T08:01:00.000Z" });
  results.webGrounding = { citationSyntax: syntax.status, servedGrounding: grounding.status, coverage: grounding.claimEvidence?.claimEvidenceMap.coverage };
  expect(syntax.status).toBe("verified");
  expect(grounding.status).toBe("missing");
});

it("accepts custom profile IDs while retaining governed child authority", () => {
  const parsed = delegateAgentTaskInputSchema.safeParse({ objective: "Review a sample proposal", taskKind: "research", acceptanceCriteria: ["List material gaps"], preferredAgentId: "custom-client-specialist" });
  const forge = durableSpecialistProfile("forge", "execute");
  results.specialistReach = { customAgentAccepted: parsed.success, forgeApprovalPolicy: forge.approvalPolicy, forgeTools: forge.toolIds, forgeSkills: forge.skills };
  expect(parsed.success).toBe(true);
  expect(forge.approvalPolicy).toBe("read_only");
});

it("reserves a cheaper single review for structured reads", () => {
  const reservation = dynamicDelegationParentToolReservation();
  results.delegationBudget = { lifecycle: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET, parentReservation: reservation, note: "Reserved ceilings, not measured token consumption or provider charges." };
  expect(reservation.tokens).toBe(104_000);
  expect(reservation.costMicrousd).toBe(1_000_000);
  expect(reservation.wallTimeMs).toBe(240_000);
  const structured = dynamicDelegationParentToolReservation(undefined, "structured_read");
  expect(structured.costMicrousd).toBe(600_000);
  expect(structured.tokens).toBe(54_000);
});

it("does not count an incomplete response or unused specialist as success", async () => {
  const run = await createAgentRun({ tenantId: "offline-review", mode: "orchestrate", prompt: "Complete a task", messages: [{ role: "user", content: "Complete a task" }], agentId: "atlas", specialistIds: ["sentinel"] });
  await completeAgentRun(run.id, "I cannot complete this task; more work remains.");
  const custom = await createAgentRun({ tenantId: "offline-review", mode: "research", prompt: "Read a proposal", messages: [{ role: "user", content: "Read a proposal" }], agentId: "custom-client-specialist" });
  await completeAgentRun(custom.id, "A draft is ready.");
  const performance = await getAgentPerformance("offline-review");
  results.performance = { atlas: performance.find(x => x.agentId === "atlas"), sentinel: performance.find(x => x.agentId === "sentinel"), customAgentPresent: performance.some(x => x.agentId === "custom-client-specialist") };
  expect(performance.find(x => x.agentId === "atlas")?.completionRate).toBeNull();
  expect(performance.find(x => x.agentId === "atlas")?.verifiedAnswers).toBe(0);
  expect(performance.find(x => x.agentId === "sentinel")?.collaborations).toBe(0);
  expect(performance.some(x => x.agentId === "custom-client-specialist")).toBe(true);
});
