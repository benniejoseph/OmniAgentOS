import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { builtInSkills } from "@/lib/skills/catalog";
import type { AgentReleaseView } from "@/lib/agents/release-store";
import type { AgentMemoryGrantDraftV1 } from "@/lib/memory/agent-grant-editor";
import {
  adaptationsRead, adaptationReceipt, agentsActionRequest, agentsRead, agentsScopeKey, agentTaskAuthorityRead,
  agentTaskCancelReceipt, builderReceipt, createAgentsGate, grantsRead, grantReceipt,
  grantRevokeReceipt, learningRead, performanceRead, releaseRead, releaseReceipt, skillsRead,
} from "./agents-workspace-state";

const t = "2026-10-03T12:00:00.000Z";
const actor = "actor:11111111-1111-4111-8111-111111111111";
const agent = {
  id: "custom-one", tenantId: "tenant-one", actorId: actor, slug: "custom-one", name: "Exact Agent", role: "Research specialist",
  description: "A scoped synthetic research specialist.", instructions: "Use cited evidence and explicit authority.", persona: DEFAULT_CUSTOM_AGENT_PERSONA,
  status: "ready" as const, accent: "emerald" as const, modelPolicy: "auto" as const, autonomy: "governed" as const,
  approvalPolicy: "risk_based" as const, memoryScope: "session" as const, skillIds: [], toolIds: [], createdAt: t, updatedAt: t,
  selectable: true, manageable: true,
};
function agentInput() { const { name, role, description, instructions, persona, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds } = agent; return { name, role, description, instructions, persona, status, accent, modelPolicy, autonomy, approvalPolicy, memoryScope, skillIds, toolIds }; }
function release(): AgentReleaseView {
  return { schemaVersion: 1, agentId: agent.id, state: "active", releaseRevision: 1, activeDefinitionVersion: 1, activeDefinitionVersionId: `definition:custom:${agent.id}:v1`, previousDefinitionVersion: null, previousDefinitionVersionId: null, latestDefinitionVersion: 2, latestDefinitionVersionId: `definition:custom:${agent.id}:v2`, candidateEvaluation: null, updatedAt: t, retiredAt: null, versions: [1,2].map((n) => ({ definitionVersion: n, definitionVersionId: `definition:custom:${agent.id}:v${n}`, publishedAt: t, active: n === 1 })), evaluations: [] };
}
function observed() {
  return { schemaVersion: 1, version: "p7.6-agent-adaptation:1", adaptationId: `agent-adaptation:${"a".repeat(64)}`, agentId: agent.id, ownerBindingSha256: "b".repeat(64), observedDefinitionVersion: 1, state: "observed", lifecycleRevision: 0, evidence: [{ evidenceId: "evidence:one", kind: "run_feedback", sourceId: "run:one", sourceSha256: "c".repeat(64), verdict: "needs_work", groundingStatus: "verified", observedAt: t }], evidenceSha256: "d".repeat(64), confidence: .9, effect: { kind: "instruction_guidance", guidance: "Verify source evidence before delivering.", guidanceSha256: "e".repeat(64), authorityImpact: "none", effectSha256: "f".repeat(64) }, evaluation: null, activationVersion: null, activatedAt: null, rolledBackAt: null, createdAt: t, updatedAt: t };
}
const draft: AgentMemoryGrantDraftV1 = { schemaVersion: 1, grantKind: "context", purposeId: "memory.retrieve.v1", target: { visibility: "agent_private", resourceIds: ["memory:one"], workspaceId: null, projectId: null, missionId: null }, maxItems: 2, maxBytes: 1000, expiresAt: "2026-10-04T12:00:00.000Z" };
function grant() {
  const principal = `agent:${agent.id}:0123456789abcdef`;
  return { explanation: "Exact scoped synthetic grant", manageable: true, record: { schemaVersion: 1, tenantId: agent.tenantId, grantKind: "context", grantId: "context:one", grantGeneration: 1, granteeKind: "agent", granteeId: principal, granteePrincipalGeneration: 2, purposeId: draft.purposeId, target: { ...draft.target, ownerActorId: actor, ownerAgentId: principal, ownerAgentPrincipalGeneration: 2 }, notBefore: t, expiresAt: draft.expiresAt, state: "active", lifecycleRevision: 1, createdByActorId: actor, activatedByActorId: actor, revokedByActorId: null, createdAt: t, activatedAt: t, revokedAt: null, updatedAt: t, operationIds: null, maxItems: 2, maxBytes: 1000, maxInvocations: null, maxCostMicrousd: null, maxDurationMs: null } };
}
function fillRetryWindow(gate: ReturnType<typeof createAgentsGate>) {
  return Array.from({ length: 30 }, (_, index) => {
    const action = gate.begin("/cancel", "POST", { expectedRevision: index }, "Cancel", index)!;
    expect(action.blockedReason).toBeUndefined();
    gate.finish(action, false);
    return action;
  });
}

describe("Agents composition lifecycle", () => {
  it("excludes transient session status while scoping owner, role and external route", () => {
    const scope = { tenantId: "t", actorId: "a", role: "operator", authenticated: true, route: ["roster"] };
    expect(agentsScopeKey({ ...scope, ...{ status: "loading" } })).toBe(agentsScopeKey({ ...scope, ...{ status: "ready" } }));
    expect(agentsScopeKey(scope)).not.toBe(agentsScopeKey({ ...scope, actorId: "b" }));
    expect(agentsScopeKey(scope)).not.toBe(agentsScopeKey({ ...scope, role: "viewer" }));
    expect(agentsScopeKey(scope)).not.toBe(agentsScopeKey({ ...scope, route: ["live", "run-two"] }));
  });
  it("closes the synchronous duplicate gap across different inspectors", () => {
    const gate = createAgentsGate(() => "key"); gate.mount();
    const first = gate.begin("/release", "POST", { action: "evaluate", definitionVersion: 2 }, "Evaluate");
    expect(first).toBeDefined(); expect(gate.begin("/grants", "POST", draft, "Grant")).toBeUndefined();
    gate.finish(first!, true); expect(gate.begin("/grants", "POST", draft, "Grant")).toBeDefined();
  });
  it("retries only the same frozen body and reviewed revision with the same key", () => {
    let id = 0; const gate = createAgentsGate(() => `key-${++id}`); gate.mount();
    const body = { expectedRevision: 3 }; const first = gate.begin("/cancel", "POST", body, "Cancel", 3)!;
    body.expectedRevision = 4; expect(first.body).toBe('{"expectedRevision":3}'); gate.finish(first, false);
    const retry = gate.begin("/cancel", "POST", { expectedRevision: 3 }, "Cancel", 3)!; expect(retry.idempotencyKey).toBe(first.idempotencyKey); gate.finish(retry, false);
    expect(gate.begin("/cancel", "POST", body, "Cancel", 4)!.idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it("refuses more than 30 uncertain actions without fetching or evicting any exact retry", async () => {
    let id = 0; const gate = createAgentsGate(() => `key-${++id}`); gate.mount();
    const originals = fillRetryWindow(gate);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
    try {
      for (let index = 30; index < 35; index += 1) {
        const blocked = gate.begin("/cancel", "POST", { expectedRevision: index }, "Cancel", index)!;
        expect(blocked.idempotencyKey).toBeUndefined();
        expect(gate.current(blocked)).toBe(true);
        expect(gate.begin("/different", "POST", {}, "Other change")).toBeUndefined();
        await expect(agentsActionRequest(blocked)).rejects.toThrow("Retry an unchanged request to confirm its result");
        expect(blocked.blockedReason).toContain("No new request was sent.");
        gate.finish(blocked, false);
        expect(gate.busy()).toBe(false);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(id).toBe(30);
      originals.forEach((original, index) => {
        const retry = gate.begin("/cancel", "POST", { expectedRevision: index }, "Cancel again", index)!;
        expect(retry.blockedReason).toBeUndefined();
        expect(retry.idempotencyKey).toBe(original.idempotencyKey);
        gate.finish(retry, false);
      });
      expect(id).toBe(30);
    } finally { fetchSpy.mockRestore(); }
  });
  it("frees exactly one retry slot only when its current admitted action is confirmed", () => {
    let id = 0; const gate = createAgentsGate(() => `key-${++id}`); gate.mount();
    const originals = fillRetryWindow(gate);
    const retry = gate.begin("/cancel", "POST", { expectedRevision: 0 }, "Cancel", 0)!;
    gate.finish(originals[0], true);
    expect(gate.current(retry)).toBe(true);
    gate.finish(retry, false);
    const blocked = gate.begin("/new", "POST", {}, "New change")!;
    expect(blocked.blockedReason).toBeDefined();
    gate.finish(blocked, true);
    const stillBlocked = gate.begin("/another", "POST", {}, "Another change")!;
    expect(stillBlocked.blockedReason).toBeDefined();
    gate.finish(stillBlocked, false);

    const confirmed = gate.begin("/cancel", "POST", { expectedRevision: 0 }, "Cancel", 0)!;
    expect(confirmed.idempotencyKey).toBe(originals[0].idempotencyKey);
    gate.finish(confirmed, true);
    const admitted = gate.begin("/new", "POST", {}, "New change")!;
    expect(admitted.blockedReason).toBeUndefined();
    expect(admitted.idempotencyKey).toBe("key-31");
    gate.finish(admitted, false);
    const fullAgain = gate.begin("/another", "POST", {}, "Another change")!;
    expect(fullAgain.blockedReason).toBeDefined();
    gate.finish(fullAgain, false);
    expect(id).toBe(31);
  });
  it("does not retain canceled GET previews as uncertain effects and permits reads at capacity", () => {
    let id = 0; const gate = createAgentsGate(() => `key-${++id}`); gate.mount();
    for (let index = 0; index < 35; index += 1) {
      const preview = gate.begin(`/agents/${index}?mode=trash-preview`, "GET", undefined, "Review removal")!;
      expect(preview.blockedReason).toBeUndefined();
      expect(gate.begin("/cancel", "POST", {}, "Cancel")).toBeUndefined();
      gate.finish(preview, false);
    }
    fillRetryWindow(gate);
    const preview = gate.begin("/agents/other?mode=trash-preview", "GET", undefined, "Review removal")!;
    expect(preview.blockedReason).toBeUndefined();
    expect(gate.current(preview)).toBe(true);
    gate.finish(preview, true);
    const blocked = gate.begin("/agents/other", "DELETE", {}, "Remove")!;
    expect(blocked.blockedReason).toBeDefined();
    gate.finish(blocked, false);
  });
  it("invalidates older reads and prevents old owner receipts after disposal", () => {
    const gate = createAgentsGate(() => "key"); gate.mount(); const old = gate.read("release");
    const action = gate.begin("/release", "POST", { action: "evaluate" }, "Evaluate")!;
    expect(old()).toBe(false); gate.dispose(); gate.mount(); expect(gate.current(action)).toBe(false);
    expect(gate.begin("/release", "POST", {}, "New owner")).toBeDefined();
  });
  it("notifies after an immediately settled action even if React batches pending and completion", () => {
    const gate = createAgentsGate(() => "key"); gate.mount(); const before = gate.snapshot();
    const action = gate.begin("/release", "POST", {}, "Evaluate")!; gate.finish(action, true);
    expect(gate.label()).toBe(""); expect(gate.snapshot()).toBeGreaterThan(before);
  });
  it("fences only the replaced source while independent reads remain valid", () => {
    const gate = createAgentsGate(); gate.mount(); const old = gate.read("agents"), skills = gate.read("skills"), latest = gate.read("agents");
    expect(old()).toBe(false); expect(skills()).toBe(true); expect(latest()).toBe(true);
  });
});

describe("Agents source truth and compatibility receipts", () => {
  it("distinguishes a successful empty collection from missing or malformed data", () => {
    expect(agentsRead({ agents: [] }, agent.tenantId)).toEqual([]);
    expect(() => agentsRead({})).toThrow(); expect(() => skillsRead({ skills: null })).toThrow();
    expect(() => agentsRead({ agents: [{ ...agent, persona: undefined }] })).toThrow();
    expect(() => agentsRead({ agents: [{ ...agent, status: ["ready"] }] })).toThrow();
  });
  it("retains exact opaque IDs and rejects duplicates and cross-tenant custom records", () => {
    expect(agentsRead({ agents: [agent] }, agent.tenantId)[0].id).toBe(agent.id);
    expect(() => agentsRead({ agents: [agent, agent] })).toThrow();
    expect(() => agentsRead({ agents: [agent] }, "other-tenant")).toThrow();
  });
  it("allows documented system-owned built-in Skills without allowing arbitrary tenant mixing", () => {
    expect(skillsRead({ skills: builtInSkills }, agent.tenantId)).toHaveLength(builtInSkills.length);
    expect(() => skillsRead({ skills: [{ ...builtInSkills[0], builtIn: false }] }, agent.tenantId)).toThrow();
  });
  it("binds exact compatibility write fields and owner without inventing a CAS receipt", () => {
    expect(builderReceipt(agent, "agent", agentInput(), agent, { tenantId: agent.tenantId, actorId: actor }).id).toBe(agent.id);
    expect(() => builderReceipt({ ...agent, id: "different" }, "agent", agentInput(), agent)).toThrow();
    expect(() => builderReceipt({ ...agent, persona: { ...agent.persona, charter: "Different returned charter" } }, "agent", agentInput(), agent)).toThrow();
    expect(() => builderReceipt({ ...agent, actorId: "other" }, "agent", agentInput(), agent)).toThrow();
  });
  it("does not manufacture zero outcomes from a missing projection", () => {
    expect(performanceRead({ agents: [] })).toEqual([]); expect(() => performanceRead({})).toThrow();
    expect(() => performanceRead({ agents: [{ agentId: agent.id }] })).toThrow();
  });
  it("binds learning counts to the requested Agent", () => {
    const learning = { schemaVersion: 1, version: "agent-daily-learning-status:1", agentId: agent.id, definitionVersion: 1, projectedAt: t, availability: "ready", latestCompletedDay: null, pendingReviewedAdaptationCount: 0, contentIncluded: false, privateReasoningIncluded: false, authorityImpact: "none" };
    expect(learningRead({ learning }, agent.id).agentId).toBe(agent.id);
    expect(() => learningRead({ learning }, "other")).toThrow();
  });
});

describe("Exact governance and task responses", () => {
  it("rejects wrong Agent release identities and inconsistent version IDs", () => {
    expect(releaseRead({ release: release() }, agent.id).activeDefinitionVersion).toBe(1);
    expect(() => releaseRead({ release: release() }, "other")).toThrow();
    expect(() => releaseRead({ release: { ...release(), activeDefinitionVersionId: "wrong" } }, agent.id)).toThrow();
  });
  it("does not call a missing evaluation a passed receipt", () => {
    expect(() => releaseReceipt({ release: release() }, release(), { action: "evaluate", definitionVersion: 2 })).toThrow();
    expect(() => releaseReceipt({ release: release() }, release(), { action: "retire", confirmation: "RETIRE AGENT" })).toThrow();
  });
  it("validates adaptation identity and exact target transitions", () => {
    const before = adaptationsRead({ definitionVersion: 1, adaptations: [observed()] }, agent.id);
    expect(before.adaptations[0].effect.guidance).toContain("Verify source");
    expect(() => adaptationsRead({ definitionVersion: 1, adaptations: [{ ...observed(), agentId: "other" }] }, agent.id)).toThrow();
    expect(() => adaptationReceipt({ definitionVersion: 1, adaptations: [observed()] }, agent.id, before, { action: "activate", adaptationId: observed().adaptationId })).toThrow();
  });
  it("checks grant principal, tenant, exact targets, expiry and limits", () => {
    expect(grantsRead({ grants: [grant()] }, agent.id, agent.tenantId)).toHaveLength(1);
    expect(grantReceipt({ grant: grant() }, agent.id, draft, agent.tenantId).record.grantId).toBe("context:one");
    expect(() => grantReceipt({ grant: grant() }, agent.id, { ...draft, maxBytes: 999 }, agent.tenantId)).toThrow();
    expect(() => grantsRead({ grants: [grant()] }, "other", agent.tenantId)).toThrow();
    expect(() => grantsRead({ grants: [grant()] }, agent.id, "other-tenant")).toThrow();
  });
  it("requires revocation acknowledgement for the exact reviewed grant record", () => {
    const exact = grantsRead({ grants: [grant()] }, agent.id)[0];
    expect(() => grantRevokeReceipt({ revoked: true, target: { agentId: agent.id, grant: exact.record }, targetSha256: "a".repeat(64) }, agent.id, exact)).not.toThrow();
    expect(() => grantRevokeReceipt({ revoked: true, target: { agentId: "other", grant: exact.record }, targetSha256: "a".repeat(64) }, agent.id, exact)).toThrow();
  });
  it("requires the exact task and next lifecycle revision for cancellation", () => {
    const task = { executionId: "task:one", state: "canceled", lifecycleRevision: 4, canCancel: false, updatedAt: t, terminalAt: t };
    expect(agentTaskCancelReceipt({ task }, task.executionId, 3).state).toBe("canceled");
    expect(() => agentTaskCancelReceipt({ task }, "task:two", 3)).toThrow();
    expect(() => agentTaskCancelReceipt({ task }, task.executionId, 4)).toThrow();
  });
  it("binds authority detail to the task and executing Agent and rejects external management links", () => {
    const authority = { immutable: true, contractSha256: "a".repeat(64), grantRequestSha256: "b".repeat(64), validation: { status: "not_checked", category: null, validatedAt: null }, nativeReadTools: [{ toolId: "knowledge.search", managementHref: "/app/automation" }], skills: [], plugins: [], mcpServers: [] };
    const task = { executionId: "task:one", delegateAgentId: agent.id, authority };
    expect(agentTaskAuthorityRead({ task }, task.executionId, agent.id).immutable).toBe(true);
    expect(() => agentTaskAuthorityRead({ task }, "task:other", agent.id)).toThrow();
    expect(() => agentTaskAuthorityRead({ task: { ...task, authority: { ...authority, nativeReadTools: [{ toolId: "knowledge.search", managementHref: "https://external.invalid" }] } } }, task.executionId, agent.id)).toThrow();
  });
});
