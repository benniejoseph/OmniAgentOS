import { customAgentInputSchema, skillInputSchema } from "@/lib/skills/schema";
import { memoryAccessGrantRecordV1Schema } from "@/lib/memory/grant-contracts";
import type { AgentMemoryGrantDraftV1, AgentMemoryGrantViewV1 } from "@/lib/memory/agent-grant-editor";
import type { AgentSkill, RequestCustomAgentDefinition } from "@/lib/skills/types";
import type { AgentPerformance } from "@/lib/agents/performance";
import type { AgentReleaseView } from "@/lib/agents/release-store";
import type { AgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";
import type { AgentDailyLearningStatusV1 } from "@/lib/agents/learning-contracts";
import type { TrashActionPreviewV1 } from "@/lib/trash/contracts";
import type { AgentTaskAuthorityDetail } from "@/components/agents/council-execution-map";

export const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const member = (v: unknown, choices: readonly string[]) => typeof v === "string" && choices.includes(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function requireValue(value: unknown): asserts value { if (!value) throw new Error("The response did not match the requested Agent, version or stored record. Refresh before making another change."); }
function list(value: unknown, check: (v: unknown) => boolean, max = 1000): value is unknown[] { return Array.isArray(value) && value.length <= max && value.every(check); }
function unique<T>(rows: T[], id: (row: T) => string) { requireValue(new Set(rows.map(id)).size === rows.length); return rows; }
export function sameAgentJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function agentsScopeKey(v: { tenantId?: string; actorId?: string; email?: string; role: string; authEnabled?: boolean; authenticated?: boolean; route?: readonly (string | undefined)[] }) {
  // Session loading is deliberately absent: a same-owner refresh must retain drafts.
  return JSON.stringify([v.tenantId, v.actorId, v.email, v.role, v.authEnabled, v.authenticated, v.route]);
}
function metadata(v: Record<string, unknown>) { return text(v.id) && text(v.tenantId) && text(v.actorId) && text(v.slug) && date(v.createdAt) && date(v.updatedAt); }
const agentKeys = ["name", "role", "description", "instructions", "persona", "status", "accent", "modelPolicy", "autonomy", "approvalPolicy", "memoryScope", "skillIds", "toolIds"];
const skillKeys = ["name", "description", "instructions", "category", "status", "toolIds", "tags", "knowledgeTags"];
function pick(v: Record<string, unknown>, keys: string[]) { return Object.fromEntries(keys.map((key) => [key, v[key]])); }
export function agentRecord(v: unknown, readable = true): RequestCustomAgentDefinition {
  requireValue(object(v) && metadata(v) && agentKeys.every((key) => v[key] !== undefined) && customAgentInputSchema.safeParse(pick(v, agentKeys)).success);
  requireValue(!readable || (typeof v.selectable === "boolean" && typeof v.manageable === "boolean"));
  requireValue(v.releaseState === undefined || member(v.releaseState, ["active", "retired"]));
  requireValue((v.activeDefinitionVersion === undefined || positive(v.activeDefinitionVersion)) && (v.latestDefinitionVersion === undefined || positive(v.latestDefinitionVersion)));
  return v as unknown as RequestCustomAgentDefinition;
}
export function skillRecord(v: unknown): AgentSkill {
  requireValue(object(v) && metadata(v) && positive(v.version) && skillKeys.every((key) => v[key] !== undefined) && skillInputSchema.safeParse(pick(v, skillKeys)).success);
  requireValue((v.manageable === undefined || typeof v.manageable === "boolean") && (v.selectable === undefined || typeof v.selectable === "boolean"));
  return v as unknown as AgentSkill;
}
export function agentsRead(v: Record<string, unknown>, tenantId?: string) {
  requireValue(Array.isArray(v.agents) && v.agents.length <= 1000);
  const rows = unique(v.agents.map((item) => agentRecord(item)), (item) => item.id);
  requireValue(rows.every((item) => !tenantId || item.tenantId === tenantId));
  return rows;
}
export function skillsRead(v: Record<string, unknown>, tenantId?: string) {
  requireValue(Array.isArray(v.skills) && v.skills.length <= 1000);
  const rows = unique(v.skills.map(skillRecord), (item) => item.id);
  requireValue(rows.every((item) => !tenantId || item.tenantId === tenantId || (item.builtIn === true && item.tenantId === "system" && item.actorId === "system" && item.manageable !== true)));
  return rows;
}
export type AgentToolOption = { id: string; name: string; riskLevel: number; category: string };
export function toolsRead(v: Record<string, unknown>): AgentToolOption[] {
  requireValue(list(v.tools, (item) => object(item) && text(item.id) && text(item.name) && text(item.category) && integer(item.riskLevel) && item.riskLevel <= 3));
  return unique(v.tools as AgentToolOption[], (item) => item.id);
}
export function performanceRead(v: Record<string, unknown>): AgentPerformance[] {
  requireValue(list(v.agents, (item) => object(item) && text(item.agentId) && ["primaryAssignments", "collaborations", "completed", "failed", "verifiedAnswers", "memoriesFormed", "usefulOutcomes", "needsWorkOutcomes"].every((key) => integer(item[key])) && ["completionRate", "userApprovalRate"].every((key) => item[key] === null || (typeof item[key] === "number" && Number.isFinite(item[key]) && item[key] >= 0 && item[key] <= 1)) && (item.latestOutcomeNotes === undefined || list(item.latestOutcomeNotes, text, 100))));
  return unique(v.agents as AgentPerformance[], (item) => item.agentId);
}
export function builderReceipt(v: unknown, kind: "agent" | "skill", submitted: Record<string, unknown>, old?: RequestCustomAgentDefinition | AgentSkill, scope?: { tenantId?: string; actorId?: string }) {
  const row = kind === "agent" ? agentRecord(v, false) : skillRecord(v);
  requireValue(object(v) && sameAgentJson(pick(v, kind === "agent" ? agentKeys : skillKeys), submitted));
  requireValue(!old || (row.id === old.id && row.tenantId === old.tenantId && row.actorId === old.actorId && Date.parse(row.updatedAt) >= Date.parse(old.updatedAt)));
  requireValue(!scope?.tenantId || row.tenantId === scope.tenantId);
  requireValue(!scope?.actorId || row.actorId === scope.actorId);
  if (kind === "skill" && old) requireValue((row as AgentSkill).version === (old as AgentSkill).version + 1);
  // Exact writes use the same owner-only service; readable-list authority is rechecked separately.
  return { ...row, manageable: true, selectable: true };
}
export function learningRead(v: Record<string, unknown>, agentId: string): AgentDailyLearningStatusV1 {
  const l = v.learning;
  requireValue(object(l) && l.schemaVersion === 1 && l.version === "agent-daily-learning-status:1" && l.agentId === agentId && positive(l.definitionVersion) && date(l.projectedAt) && member(l.availability, ["ready", "canonical_store_unavailable"]) && integer(l.pendingReviewedAdaptationCount) && l.contentIncluded === false && l.privateReasoningIncluded === false && l.authorityImpact === "none");
  requireValue(l.latestCompletedDay === null || (object(l.latestCompletedDay) && text(l.latestCompletedDay.localDate) && text(l.latestCompletedDay.timezone) && date(l.latestCompletedDay.completedAt) && ["observationsReviewed", "explicitCorrectionCount", "actionableEvidenceCount"].every((key) => integer((l.latestCompletedDay as Record<string, unknown>)[key])) && member(l.latestCompletedDay.outcome, ["actionable_evidence_recorded", "no_actionable_evidence"])));
  requireValue(l.availability !== "canonical_store_unavailable" || (l.latestCompletedDay === null && l.pendingReviewedAdaptationCount === 0));
  return l as unknown as AgentDailyLearningStatusV1;
}
export function releaseRead(v: Record<string, unknown>, agentId: string): AgentReleaseView {
  const r = v.release;
  requireValue(object(r) && r.schemaVersion === 1 && r.agentId === agentId && member(r.state, ["active", "retired"]) && positive(r.releaseRevision) && positive(r.activeDefinitionVersion) && positive(r.latestDefinitionVersion) && r.latestDefinitionVersion >= r.activeDefinitionVersion && date(r.updatedAt));
  const versionId = (version: unknown) => `definition:custom:${agentId}:v${version}`;
  requireValue(r.activeDefinitionVersionId === versionId(r.activeDefinitionVersion) && r.latestDefinitionVersionId === versionId(r.latestDefinitionVersion) && ((r.previousDefinitionVersion === null && r.previousDefinitionVersionId === null) || (positive(r.previousDefinitionVersion) && r.previousDefinitionVersionId === versionId(r.previousDefinitionVersion))) && (r.state === "retired" ? date(r.retiredAt) : r.retiredAt === null));
  requireValue(list(r.versions, (item) => object(item) && positive(item.definitionVersion) && item.definitionVersionId === versionId(item.definitionVersion) && date(item.publishedAt) && item.active === (item.definitionVersion === r.activeDefinitionVersion), 1000));
  requireValue(list(r.evaluations, (e) => object(e) && e.schemaVersion === 1 && e.version === "p7.5-agent-release-evaluation:1" && e.agentId === agentId && e.definitionId === `definition:custom:${agentId}` && e.policyVersionId === "agent-release-policy:1" && typeof e.evaluationId === "string" && /^agent-release-evaluation:[a-f0-9]{64}$/.test(e.evaluationId) && positive(e.definitionVersion) && e.definitionVersionId === versionId(e.definitionVersion) && hash(e.definitionSha256) && positive(e.baselineDefinitionVersion) && e.baselineDefinitionVersionId === versionId(e.baselineDefinitionVersion) && hash(e.baselineDefinitionSha256) && hash(e.evaluationSha256) && e.verdict === "passed" && member(e.direction, ["promotion", "rollback"]) && list(e.changedFields, text, 10) && object(e.checks) && ["exactOwnerBinding", "versionTransition", "immutableDefinitionDigest", "personaContract", "skillPins", "authorityExcluded", "materialChange"].every((key) => (e.checks as Record<string, unknown>)[key] === true) && date(e.evaluatedAt), 1000));
  const result = r as unknown as AgentReleaseView;
  unique([...result.versions], (item) => item.definitionVersionId); unique([...result.evaluations], (item) => item.evaluationId);
  requireValue(result.versions.some((item) => item.active));
  return result;
}
export function releaseReceipt(v: Record<string, unknown>, before: AgentReleaseView, input: Record<string, unknown>) {
  const next = releaseRead(v, before.agentId);
  requireValue(next.releaseRevision >= before.releaseRevision);
  if (input.action === "evaluate") requireValue(next.activeDefinitionVersion === before.activeDefinitionVersion && next.evaluations.some((item) => item.definitionVersion === input.definitionVersion && item.baselineDefinitionVersion === before.activeDefinitionVersion));
  else if (input.action === "retire") requireValue(next.state === "retired");
  else {
    const evaluation = before.evaluations.find((item) => item.evaluationId === input.evaluationId);
    requireValue(evaluation && next.state === "active" && next.activeDefinitionVersionId === evaluation.definitionVersionId && next.releaseRevision > before.releaseRevision);
  }
  return next;
}
export type AdaptationRead = { adaptations: AgentAdaptationV1[]; definitionVersion: number };
export function adaptationsRead(v: Record<string, unknown>, agentId: string): AdaptationRead {
  requireValue(positive(v.definitionVersion) && list(v.adaptations, (a) => {
    if (!object(a) || a.schemaVersion !== 1 || a.version !== "p7.6-agent-adaptation:1" || a.agentId !== agentId || !text(a.adaptationId) || !hash(a.ownerBindingSha256) || !positive(a.observedDefinitionVersion) || !member(a.state, ["observed", "evaluated", "active", "rolled_back"]) || !object(a.effect) || a.effect.kind !== "instruction_guidance" || !text(a.effect.guidance) || a.effect.authorityImpact !== "none" || !hash(a.effect.effectSha256) || !hash(a.effect.guidanceSha256) || typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 || !date(a.createdAt) || !date(a.updatedAt) || !hash(a.evidenceSha256)) return false;
    if (!list(a.evidence, (e) => object(e) && text(e.evidenceId) && text(e.sourceId) && hash(e.sourceSha256) && member(e.kind, ["run_feedback", "project_artifact", "delegated_task", "scheduled_trigger"]) && member(e.verdict, ["useful", "needs_work"]) && member(e.groundingStatus, ["verified", "not_required"]) && date(e.observedAt), 10)) return false;
    if (a.state === "observed") return a.lifecycleRevision === 0 && a.evaluation === null && a.activationVersion === null;
    if (!object(a.evaluation) || !positive(a.evaluation.definitionVersion) || !hash(a.evaluation.evaluationSha256) || !member(a.evaluation.verdict, ["passed", "held"]) || a.evaluation.policyVersionId !== "agent-adaptation-policy:1" || a.evaluation.version !== "p7.6-agent-adaptation-evaluation:1" || !date(a.evaluation.evaluatedAt) || !object(a.evaluation.checks) || !["evidenceIntegrity", "ownerBinding", "exactDefinitionVersion", "nonAuthorityEffect"].every((key) => (a.evaluation as {checks:Record<string,unknown>}).checks[key] === true) || typeof a.evaluation.checks.confidenceThreshold !== "boolean" || a.evaluation.verdict !== (a.evaluation.checks.confidenceThreshold ? "passed" : "held")) return false;
    if (a.state === "evaluated") return a.lifecycleRevision === 1 && a.activationVersion === null;
    return a.evaluation.verdict === "passed" && positive(a.activationVersion) && date(a.activatedAt) && (a.state === "active" ? a.lifecycleRevision === 2 && a.rolledBackAt === null : a.lifecycleRevision === 3 && date(a.rolledBackAt));
  }, 100));
  return { definitionVersion: v.definitionVersion, adaptations: unique(v.adaptations as AgentAdaptationV1[], (item) => item.adaptationId) };
}
export function adaptationReceipt(v: Record<string, unknown>, agentId: string, before: AdaptationRead, input: Record<string, unknown>) {
  const next = adaptationsRead(v, agentId);
  if (input.action !== "refresh") {
    const old = before.adaptations.find((item) => item.adaptationId === input.adaptationId), changed = next.adaptations.find((item) => item.adaptationId === input.adaptationId);
    const state = input.action === "evaluate" ? "evaluated" : input.action === "activate" ? "active" : "rolled_back";
    requireValue(old && changed && changed.state === state && changed.lifecycleRevision === old.lifecycleRevision + 1 && changed.evidenceSha256 === old.evidenceSha256 && changed.effect.effectSha256 === old.effect.effectSha256 && (input.action === "rollback" || next.definitionVersion === before.definitionVersion));
  }
  return next;
}
export function grantView(v: unknown, agentId: string): AgentMemoryGrantViewV1 {
  requireValue(object(v) && text(v.explanation) && typeof v.manageable === "boolean");
  const parsed = memoryAccessGrantRecordV1Schema.safeParse(v.record);
  requireValue(parsed.success && parsed.data.granteeKind === "agent" && parsed.data.granteeId.startsWith(`agent:${agentId}:`) && /^[a-f0-9]{16}$/.test(parsed.data.granteeId.slice(`agent:${agentId}:`.length)));
  return v as unknown as AgentMemoryGrantViewV1;
}
export function grantsRead(v: Record<string, unknown>, agentId: string, tenantId?: string) {
  requireValue(Array.isArray(v.grants) && v.grants.length <= 1000);
  const rows = unique(v.grants.map((g) => grantView(g, agentId)), (g) => g.record.grantId);
  requireValue(rows.every((g) => !tenantId || g.record.tenantId === tenantId));
  requireValue(new Set(rows.map((g) => `${g.record.granteeId}:${g.record.granteePrincipalGeneration}:${g.record.target.ownerActorId}`)).size <= 1);
  return rows;
}
export function grantReceipt(v: Record<string, unknown>, agentId: string, draft: AgentMemoryGrantDraftV1, tenantId?: string, prior?: AgentMemoryGrantViewV1) {
  const grant = grantView(v.grant, agentId), r = grant.record;
  requireValue(!tenantId || r.tenantId === tenantId);
  requireValue(!prior || (r.granteeId === prior.record.granteeId && r.target.ownerActorId === prior.record.target.ownerActorId && (r.granteePrincipalGeneration || 0) > (prior.record.granteePrincipalGeneration || 0)));
  requireValue(r.state === "active" && grant.manageable && r.grantKind === draft.grantKind && r.purposeId === draft.purposeId && r.expiresAt === draft.expiresAt && Object.entries(draft.target).every(([key, value]) => sameAgentJson(r.target[key as keyof typeof r.target], value)));
  const limits = draft.grantKind === "context" ? ["maxItems", "maxBytes"] : ["operationIds", "maxInvocations", "maxCostMicrousd", "maxDurationMs"];
  requireValue(limits.every((key) => sameAgentJson(r[key as keyof typeof r], draft[key as keyof typeof draft])));
  return grant;
}
export function grantRevokeReceipt(v: Record<string, unknown>, agentId: string, grant: AgentMemoryGrantViewV1) {
  requireValue(v.revoked === true && object(v.target) && v.target.agentId === agentId && sameAgentJson(v.target.grant, grant.record) && hash(v.targetSha256));
}
export function agentTrashPreview(v: unknown, id: string, kind: "agent" | "skill"): TrashActionPreviewV1 {
  requireValue(object(v) && v.version === "p9.3-trash-preview:1" && v.action === "trash" && v.resourceType === (kind === "agent" ? "custom_agent" : "agent_skill") && v.resourceId === id && v.trashId === null && text(v.effectSummary) && hash(v.targetSha256) && hash(v.previewSha256) && date(v.issuedAt) && date(v.expiresAt) && Date.parse(v.expiresAt as string) > Date.now());
  return v as unknown as TrashActionPreviewV1;
}
export function agentTrashReceipt(v: Record<string, unknown>, preview: TrashActionPreviewV1) {
  requireValue(v.movedToTrash === true && object(v.trash) && v.trash.resourceId === preview.resourceId && v.trash.resourceType === preview.resourceType && v.trash.targetSha256 === preview.targetSha256 && v.trash.state === "retained" && date(v.trash.restoreUntil) && object(v.effectReceipt) && v.effectReceipt.previewSha256 === preview.previewSha256 && v.effectReceipt.resourceId === preview.resourceId && v.effectReceipt.resourceType === preview.resourceType && v.effectReceipt.afterState === "retained" && member(v.effectReceipt.outcome, ["applied", "already_applied"]));
  return v.trash.restoreUntil as string;
}
export function agentTaskAuthorityRead(v: Record<string, unknown>, taskId: string, agentId: string): AgentTaskAuthorityDetail {
  const task = v.task;
  requireValue(object(task) && task.executionId === taskId && task.delegateAgentId === agentId && object(task.authority));
  const a = task.authority;
  requireValue(a.immutable === true && hash(a.contractSha256) && hash(a.grantRequestSha256) && object(a.validation) && member(a.validation.status, ["not_checked", "current", "changed"]) && (a.validation.category === null || member(a.validation.category, ["all_grants", "capability_binding"])) && (a.validation.validatedAt === null || date(a.validation.validatedAt)));
  const href = (v: unknown) => member(v, ["/app/automation", "/app/tools", "/app/automation?view=skills", "/app/automation?view=plugins", "/app/automation?view=connections"]);
  requireValue(list(a.nativeReadTools, (g) => object(g) && text(g.toolId) && href(g.managementHref), 256));
  requireValue(list(a.skills, (g) => object(g) && text(g.capabilityGrantId) && text(g.skillId) && positive(g.skillVersion) && text(g.skillVersionId) && hash(g.skillSha256) && href(g.managementHref), 256));
  requireValue(list(a.plugins, (g) => object(g) && text(g.capabilityGrantId) && text(g.installationId) && positive(g.installationRevision) && hash(g.installationSha256) && text(g.pluginId) && text(g.pluginVersion) && hash(g.manifestSha256) && list(g.componentIds, text, 256) && href(g.managementHref), 256));
  requireValue(list(a.mcpServers, (g) => object(g) && text(g.capabilityGrantId) && text(g.serverId) && text(g.serverVersionId) && hash(g.serverContractSha256) && list(g.governedToolIds, text, 256) && list(g.connectorTargetIds, text, 256) && href(g.managementHref), 256));
  return a as unknown as AgentTaskAuthorityDetail;
}
export type AgentCanceledTask = { executionId: string; state: "canceled"; lifecycleRevision: number; canCancel: false; updatedAt: string; terminalAt: string | null };
export function agentTaskCancelReceipt(v: Record<string, unknown>, taskId: string, revision: number): AgentCanceledTask {
  const t = v.task;
  requireValue(object(t) && t.executionId === taskId && t.state === "canceled" && t.lifecycleRevision === revision + 1 && t.canCancel === false && date(t.updatedAt) && date(t.terminalAt));
  return t as AgentCanceledTask;
}

/** Local duplicate/disposal fence. The server remains the authority for access and CAS. */
export function createAgentsGate(key: () => string = () => crypto.randomUUID()) {
  let mounted = false, epoch = 0, revision = 0, action: AgentsAction | undefined;
  const listeners = new Set<() => void>(), reads = new Map<string, number>(), retries = new Map<string, string>();
  const emit = () => { revision += 1; listeners.forEach((listener) => listener()); };
  return {
    mount() { mounted = true; },
    dispose() { mounted = false; epoch += 1; reads.clear(); retries.clear(); action = undefined; emit(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    label: () => action?.label || "",
    busy: () => action !== undefined,
    read(source: string) { const revision = (reads.get(source) || 0) + 1, generation = epoch; reads.set(source, revision); return () => mounted && generation === epoch && reads.get(source) === revision; },
    invalidateReads() { epoch += 1; reads.clear(); },
    begin(path: string, method: string, input: unknown, label: string, reviewedIdentity?: unknown) {
      if (!mounted || action) return undefined;
      epoch += 1; reads.clear();
      const body = input === undefined ? undefined : JSON.stringify(input), fingerprint = JSON.stringify([path, method, body, reviewedIdentity]);
      const mutation = !["GET", "HEAD"].includes(method.toUpperCase());
      const retryKey = retries.get(fingerprint);
      // Never evict an uncertain write: its exact retry must retain the original key.
      // A blocked token reaches the callers' existing async error UI without a request.
      if (mutation && retryKey === undefined && retries.size >= 30) {
        action = Object.freeze({ path, method, body, fingerprint, label, blockedReason: "30 earlier changes still have unconfirmed results. Retry an unchanged request to confirm its result before making a different change. No new request was sent." });
      } else {
        const idempotencyKey = retryKey ?? key();
        // GET-only previews can be canceled without creating an uncertain effect.
        if (mutation) retries.set(fingerprint, idempotencyKey);
        action = Object.freeze({ path, method, body, fingerprint, idempotencyKey, label });
      }
      emit(); return action;
    },
    current(token: AgentsAction) { return mounted && action === token; },
    finish(token: AgentsAction, accepted: boolean) { if (action === token) { action = undefined; if (accepted && token.blockedReason === undefined) retries.delete(token.fingerprint); emit(); } },
  };
}
export type AgentsAction = Readonly<{ path: string; method: string; body?: string; fingerprint: string; label: string } & (
  { idempotencyKey: string; blockedReason?: never } | { idempotencyKey?: never; blockedReason: string }
)>;
export type AgentsGate = ReturnType<typeof createAgentsGate>;
export async function readAgentsJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : `The request could not be completed (${response.status}).`);
  requireValue(object(value)); return value;
}
export async function agentsActionRequest(action: AgentsAction) {
  if (action.blockedReason !== undefined) throw new Error(action.blockedReason);
  return readAgentsJson(action.path, { method: action.method, headers: { "content-type": "application/json", "idempotency-key": action.idempotencyKey }, body: action.body });
}
