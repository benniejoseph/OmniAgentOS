import type { CustomerAccount360, CustomerAccountRevision, CustomerFactView } from "@/lib/customer-success/contracts";
import type { CustomerHealthPolicy, CustomerHealthScore } from "@/lib/customer-success/health-contracts";
import type { CustomerSuccessAccountIntelligence, CustomerSuccessPortfolio } from "@/lib/customer-success/intelligence-contracts";
import type { CustomerSuccessWorkflowDefinition, CustomerSuccessWorkflowRunRevision } from "@/lib/customer-success/workflow-contracts";
import type { SalesforceSyncHealth } from "@/lib/customer-success/salesforce-contracts";
import { CUSTOMER_FACT_KINDS } from "@/lib/customer-success/fact-kinds";

export type AccountReadState = { state: "idle" | "loading" | "ready" | "error"; error?: string };
export type AccountsContext = { workspaceId: string; accessLevel: "reader" | "contributor" | "manager"; canWrite: boolean; authoritySha256: string };
export type HealthPayload = { policy: CustomerHealthPolicy; score: CustomerHealthScore | null; history: CustomerHealthScore[] };
export type WorkflowPayload = { pack: CustomerSuccessWorkflowDefinition[]; runs: CustomerSuccessWorkflowRunRevision[] };
/** A transient session recheck is not a new authority or a new dossier. */
export function accountsScopeKey(value: { tenantId?: string; actorId?: string; email?: string; role: string; authEnabled?: boolean; authenticated?: boolean; accountId?: string }) {
  return JSON.stringify([value.tenantId, value.actorId, value.email, value.role, value.authEnabled, value.authenticated, value.accountId]);
}
export type SalesforcePayload = {
  context: AccountsContext;
  health: SalesforceSyncHealth;
  findings: Array<{ findingId: string; objectType: string; findingKind: string; observedAt: string }>;
  authorizeUrl: string;
  webhook: { configured: boolean };
  writes: { configured: boolean; enabled: boolean; mode: "approval_required"; createObjects: string[]; updateObjects: string[]; operations: Array<{ operationId: string; state: "prepared" | "verified" | "failed"; verificationReasonCode: string | null; completedAt: string | null }> };
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const member = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
const array = (value: unknown, max: number, check: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= max && value.every(check);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("This source returned an incomplete or mismatched account response. Refresh to check it again."); }
const owner = (value: unknown) => record(value) && text(value.ownerKind) && text(value.ownerId) && text(value.displayName);
const lifecycle = ["prospect", "onboarding", "active", "at_risk", "churned", "archived"];

export function accountContext(value: unknown): AccountsContext {
  requireValue(record(value) && text(value.workspaceId) && member(value.accessLevel, ["reader", "contributor", "manager"]) && typeof value.canWrite === "boolean" && hash(value.authoritySha256));
  return value as unknown as AccountsContext;
}
export function accountRevision(value: unknown, accountId?: string): CustomerAccountRevision {
  requireValue(record(value) && value.schemaVersion === 1 && value.contractVersion === "p10.9-customer-account-360:1" && text(value.tenantId) && text(value.workspaceId) && text(value.accountId) && /^customer-account:[a-f0-9]{64}$/.test(value.accountId) && (!accountId || value.accountId === accountId) && count(value.revision) && value.revision > 0 && value.revisionId === `${value.accountId}:v${value.revision}` && hash(value.accountSha256) && text(value.accountEntityId) && text(value.name) && member(value.lifecycle, lifecycle) && owner(value.accountOwner) && text(value.ownerActorId) && date(value.revisedAt));
  const permissions = value.crmPermissions;
  requireValue(value.previousRevisionId === (value.revision === 1 ? null : `${value.accountId}:v${value.revision - 1}`));
  requireValue(record(permissions) && permissions.readScope === "workspace_members" && permissions.writeScope === "account_owner" && member(permissions.externalWriteState, ["disabled", "approval_required"]) && array(permissions.customerDataPurposeIds, 5, text));
  return value as unknown as CustomerAccountRevision;
}
export function accountList(value: Record<string, unknown>, tenantId?: string) {
  const context = accountContext(value.context);
  requireValue(Array.isArray(value.accounts) && value.accounts.length <= 200);
  const accounts = value.accounts.map((raw) => accountRevision(raw));
  requireValue(new Set(accounts.map((item) => item.accountId)).size === accounts.length && accounts.every((item) => item.workspaceId === context.workspaceId && (!tenantId || item.tenantId === tenantId)));
  return { accounts, context };
}
function factView(raw: unknown, accountId: string): raw is CustomerFactView {
  if (!record(raw) || !record(raw.fact) || !record(raw.freshness) || !record(raw.conflict)) return false;
  const f = raw.fact, s = f.source, v = f.value;
  if (!text(f.factId) || !text(f.factRevisionId) || f.accountId !== accountId || !hash(f.factSha256) || !text(f.factKey) || !count(f.confidenceBasisPoints, 10000) || !owner(f.owner) || !record(s) || !text(s.sourceLabel) || !text(s.sourceKind) || !text(s.sourceRevisionId) || !hash(s.sourceRevisionSha256) || !array(s.allowedPurposeIds, 5, text) || !record(v) || !member(v.kind, CUSTOMER_FACT_KINDS)) return false;
  const titleKey = ["organization", "contact", "stakeholder", "product", "opportunity", "project"].includes(String(v.kind)) ? "name" : ["case", "risk"].includes(String(v.kind)) ? "title" : v.kind === "usage" ? "label" : v.kind === "renewal" ? "renewalAt" : "summary";
  if (!text(v[titleKey])) return false;
  const required: Record<string, string[]> = { stakeholder: ["role", "stance"], product: ["status"], opportunity: ["stage"], case: ["status", "severity"], usage: ["unit"], project: ["status"], interaction: ["channel"], health: ["dimension", "status"], risk: ["severity", "status"], renewal: ["status"] };
  if ((required[String(v.kind)] || []).some((key) => !text(v[key]))) return false;
  if (v.kind === "usage" && (typeof v.value !== "number" || !Number.isFinite(v.value))) return false;
  if (v.kind === "renewal" && !date(v.renewalAt)) return false;
  if (["opportunity", "renewal"].includes(String(v.kind)) && !((v.amountMinor === null && v.currency === null) || (count(v.amountMinor) && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency)))) return false;
  if (v.currency !== undefined && v.currency !== null && !(typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency))) return false;
  if (v.amountMinor !== undefined && v.amountMinor !== null && !count(v.amountMinor)) return false;
  return member(raw.freshness.status, ["fresh", "stale", "future", "expired", "unknown"]) && date(raw.freshness.observedAt) && (raw.freshness.staleAfter === null || date(raw.freshness.staleAfter)) && member(raw.conflict.state, ["none", "conflicting"]) && array(raw.conflict.conflictingFactIds, 100, text);
}
export function accountDetail(value: Record<string, unknown>, accountId: string, tenantId?: string) {
  const context = accountContext(value.context);
  requireValue(record(value.account));
  const detail = value.account;
  const account = accountRevision(detail.account, accountId);
  requireValue(account.workspaceId === context.workspaceId && (!tenantId || account.tenantId === tenantId) && array(detail.facts, 5000, (item) => factView(item, accountId)) && record(detail.factsByKind) && count(detail.historyCount) && count(detail.conflictCount) && count(detail.staleCount) && date(detail.evaluatedAt));
  const facts = detail.facts as CustomerFactView[];
  requireValue(new Set(facts.map((view) => view.fact.factId)).size === facts.length && facts.every((view) => view.fact.workspaceId === context.workspaceId && view.fact.tenantId === account.tenantId));
  for (const kind of CUSTOMER_FACT_KINDS) {
    requireValue(array(detail.factsByKind[kind], 5000, (item) => factView(item, accountId) && item.fact.value.kind === kind));
    requireValue(sameJson(detail.factsByKind[kind], facts.filter((view) => view.fact.value.kind === kind)));
  }
  return { detail: detail as unknown as CustomerAccount360, context };
}
function healthScore(value: unknown, accountId: string): value is CustomerHealthScore {
  if (!record(value) || value.accountId !== accountId || !text(value.scoreRevisionId) || !text(value.accountRevisionId) || !hash(value.accountSha256) || !hash(value.scoreSha256) || !count(value.revision) || !record(value.policy) || !text(value.policy.policyVersion) || !member(value.status, ["healthy", "watch", "at_risk", "unknown"]) || !count(value.confidenceBasisPoints, 10000) || !count(value.coverageBasisPoints, 10000) || !(value.scoreBasisPoints === null || count(value.scoreBasisPoints, 10000)) || (value.status === "unknown") !== (value.scoreBasisPoints === null) || value.authority !== "deterministic_policy" || !date(value.evaluatedAt)) return false;
  return array(value.factors, 20, (f) => record(f) && text(f.factorKey) && text(f.label) && count(f.weightBasisPoints, 10000) && (f.scoreBasisPoints === null || count(f.scoreBasisPoints, 10000)) && count(f.confidenceBasisPoints, 10000) && text(f.evidenceState) && array(f.evidence, 5000, (e) => record(e) && text(e.factRevisionId) && text(e.freshnessStatus) && (e.rawScoreBasisPoints === null || count(e.rawScoreBasisPoints, 10000)) && count(e.effectiveConfidenceBasisPoints, 10000))) && array(value.suggestions, 20, (s) => record(s) && text(s.suggestionId) && text(s.statement) && text(s.suggestionKind) && count(s.confidenceBasisPoints, 10000) && array(s.citedFactRevisionIds, 50, text));
}
export function healthRead(value: Record<string, unknown>, accountId: string): HealthPayload {
  const context = accountContext(value.context);
  requireValue(record(value.policy) && text(value.policy.policyVersion) && (value.score === null || healthScore(value.score, accountId)) && array(value.history, 20, (item) => healthScore(item, accountId)));
  requireValue((value.score === null || value.score.workspaceId === context.workspaceId) && value.history.every((item) => (item as CustomerHealthScore).workspaceId === context.workspaceId));
  return value as unknown as HealthPayload;
}
export function healthReceipt(value: unknown, account: CustomerAccountRevision): CustomerHealthScore {
  requireValue(healthScore(value, account.accountId) && value.accountRevisionId === account.revisionId && value.accountSha256 === account.accountSha256 && value.workspaceId === account.workspaceId && value.tenantId === account.tenantId);
  return value;
}
const workflows = ["onboarding", "adoption_review", "risk_escalation", "renewal_planning", "qbr_ebr", "meeting_prep_follow_up", "support_escalation", "expansion_discovery"];
function workflowRun(value: unknown, accountId: string): value is CustomerSuccessWorkflowRunRevision {
  return record(value) && value.accountId === accountId && text(value.runId) && count(value.revision) && value.revision > 0 && value.runRevisionId === `${value.runId}:v${value.revision}` && text(value.accountRevisionId) && hash(value.accountSha256) && hash(value.runSha256) && hash(value.definitionSha256) && member(value.workflowId, workflows) && text(value.projectId) && record(value.input) && value.input.workflowId === value.workflowId && record(value.outcome) && member(value.outcome.status, ["in_progress", "completed", "blocked", "cancelled"]) && text(value.outcome.nextAction) && hash(value.outcome.receiptSha256);
}
export function workflowRead(value: Record<string, unknown>, accountId: string): WorkflowPayload {
  const context = accountContext(value.context);
  requireValue(array(value.pack, 8, (d) => record(d) && member(d.workflowId, workflows) && text(d.name) && text(d.description) && hash(d.definitionSha256) && array(d.acceptanceCriteria, 100, text) && array(d.artifacts, 100, (a) => record(a) && text(a.title) && typeof a.required === "boolean") && array(d.evidenceRequirements, 100, (a) => record(a) && text(a.title) && typeof a.required === "boolean")) && array(value.runs, 50, (run) => workflowRun(run, accountId)));
  requireValue(value.runs.every((run) => (run as CustomerSuccessWorkflowRunRevision).workspaceId === context.workspaceId));
  return value as unknown as WorkflowPayload;
}
export function workflowReceipt(value: unknown, account: CustomerAccountRevision, definition: CustomerSuccessWorkflowDefinition, input: unknown): CustomerSuccessWorkflowRunRevision {
  requireValue(workflowRun(value, account.accountId) && value.accountRevisionId === account.revisionId && value.accountSha256 === account.accountSha256 && value.workspaceId === account.workspaceId && value.tenantId === account.tenantId && value.definitionSha256 === definition.definitionSha256 && value.workflowId === definition.workflowId && sameJson(value.input, input));
  return value;
}
function recommendation(value: unknown) {
  return record(value) && text(value.title) && text(value.reason) && text(value.action) && count(value.confidenceBasisPoints, 10000) && record(value.freshness) && text(value.freshness.status) && value.suggested === true && value.authoritative === false && array(value.uncertainty, 100, text) && array(value.evidence, 50, (e) => record(e) && text(e.refId));
}
function portfolioItem(value: unknown) {
  return record(value) && text(value.accountId) && text(value.accountRevisionId) && hash(value.accountSha256) && text(value.attention) && recommendation(value.nextBestAction);
}
export function portfolioRead(value: Record<string, unknown>): CustomerSuccessPortfolio {
  accountContext(value.context);
  const p = value.portfolio;
  requireValue(record(p) && date(p.generatedAt) && hash(p.projectionSha256) && array(p.accounts, 200, portfolioItem) && record(p.counts) && ["total", "urgent", "attention", "pendingApprovals", "overdueCommitments"].every((key) => count(p.counts && (p.counts as Record<string, unknown>)[key])));
  return p as unknown as CustomerSuccessPortfolio;
}
export function intelligenceRead(value: Record<string, unknown>, accountId: string): CustomerSuccessAccountIntelligence {
  accountContext(value.context);
  const i = value.intelligence;
  requireValue(record(i) && date(i.generatedAt) && hash(i.projectionSha256) && portfolioItem(i.portfolio) && record(i.portfolio) && i.portfolio.accountId === accountId && recommendation(i.nextBestAction) && array(i.risks, 250, (r) => record(r) && text(r.riskId) && text(r.title) && text(r.reason) && text(r.severity) && record(r.freshness) && text(r.freshness.status)) && array(i.commitments, 500, (c) => record(c) && text(c.commitmentSha256) && text(c.summary) && text(c.status) && (c.dueAt === null || date(c.dueAt))) && array(i.approvals, 100, (a) => record(a) && text(a.approvalId) && text(a.title) && member(a.kind, ["tool", "workflow"]) && text(a.status) && count(a.riskLevel, 3) && date(a.createdAt)) && array(i.timeline, 250, (t) => record(t) && text(t.eventId) && text(t.title) && text(t.summary) && date(t.occurredAt)));
  return i as unknown as CustomerSuccessAccountIntelligence;
}
export function accountReceipt(raw: unknown, submission: { account?: CustomerAccountRevision; name?: string; lifecycle: string; workspaceId: string; tenantId?: string; accountOwner?: CustomerAccountRevision["accountOwner"] }): CustomerAccountRevision {
  const value = accountRevision(raw, submission.account?.accountId);
  requireValue(value.workspaceId === submission.workspaceId && value.lifecycle === submission.lifecycle);
  if (submission.account) requireValue(value.tenantId === submission.account.tenantId && value.revision === submission.account.revision + 1 && value.previousRevisionId === submission.account.revisionId && value.name === submission.account.name && value.ownerActorId === submission.account.ownerActorId && value.accountEntityId === submission.account.accountEntityId && value.organizationEntityId === submission.account.organizationEntityId && sameJson(value.accountOwner, submission.account.accountOwner) && sameJson(value.crmPermissions, submission.account.crmPermissions));
  else requireValue(value.revision === 1 && value.previousRevisionId === null && value.name === submission.name?.trim() && (!submission.tenantId || value.tenantId === submission.tenantId) && (!submission.accountOwner || sameJson(value.accountOwner, submission.accountOwner)));
  return value;
}
export function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function salesforceRead(value: Record<string, unknown>): SalesforcePayload {
  const context = accountContext(value.context), h = value.health, w = value.writes;
  requireValue(record(h) && h.workspaceId === context.workspaceId && typeof h.configured === "boolean" && typeof h.connected === "boolean" && member(h.status, ["configuration_required", "disconnected", "idle", "backfilling", "syncing", "healthy", "degraded", "error"]) && h.accessMode === "read_only" && array(h.objectScope, 8, text) && (h.lagSeconds === null || count(h.lagSeconds)) && date(h.evaluatedAt));
  requireValue(h.cursor === null || (record(h.cursor) && record(h.cursor.objects) && Object.values(h.cursor.objects).every((item) => record(item) && member(item.phase, ["pending", "backfill", "delta", "current"]))));
  requireValue(h.actionableError === null || (record(h.actionableError) && text(h.actionableError.message) && text(h.actionableError.action)));
  requireValue(record(value.webhook) && typeof value.webhook.configured === "boolean" && record(w) && typeof w.configured === "boolean" && typeof w.enabled === "boolean" && w.mode === "approval_required" && array(w.createObjects, 20, text) && array(w.updateObjects, 20, text) && array(w.operations, 25, (item) => record(item) && text(item.operationId) && member(item.state, ["prepared", "verified", "failed"])));
  requireValue(array(value.findings, 50, (item) => record(item) && text(item.findingId) && text(item.objectType) && text(item.findingKind) && date(item.observedAt)));
  requireValue(typeof value.authorizeUrl === "string" && value.authorizeUrl.startsWith("/api/oauth/salesforce/authorize?"));
  const href = new URL(value.authorizeUrl, "https://local.invalid");
  requireValue(href.origin === "https://local.invalid" && href.pathname === "/api/oauth/salesforce/authorize" && href.searchParams.get("workspaceId") === context.workspaceId && href.searchParams.get("returnTo") === "/app/accounts");
  return value as unknown as SalesforcePayload;
}
export function salesforceReceipt(value: Record<string, unknown>, action: "sync" | "reconcile" | "disconnect") {
  let message: string;
  if (action === "sync") {
    requireValue(member(value.status, ["busy", "healthy", "partial"]) && count(value.records) && count(value.pages) && count(value.advanced) && count(value.conflicts));
    message = value.status === "busy" ? "Salesforce is already syncing. This request did not start another sync." : `Salesforce sync ${value.status} · ${value.records} records observed. ${value.status === "partial" ? "More source pages remain." : "The bounded sync request finished."}`;
  } else if (action === "reconcile") {
    requireValue(member(value.status, ["busy", "complete"]) && count(value.checked) && count(value.findings));
    message = value.status === "busy" ? "Salesforce is busy. This request did not start reconciliation." : `Read-only reconciliation checked ${value.checked} records and found ${value.findings} differences.`;
  } else {
    requireValue(value.revoked === true && value.provider === "salesforce" && typeof value.providerRevoked === "boolean" && member(value.providerRevocation, ["revoked", "not_needed", "failed"]) && value.providerRevoked === (value.providerRevocation === "revoked"));
    message = `Salesforce disconnected locally. Imported evidence remains in history. ${value.providerRevocation === "failed" ? "Provider revocation was not confirmed; review access at Salesforce." : value.providerRevocation === "revoked" ? "Provider access was revoked." : "Provider revocation was not needed."}`;
  }
  return { message, value };
}

/** Shared slot closes the synchronous gap before React commits disabled controls. */
export function createAccountsGate(key: () => string = () => crypto.randomUUID()) {
  let mounted = false, epoch = 0;
  const reads = new Map<string, number>();
  let action: object | undefined;
  const retries = new Map<string, string>();
  return {
    mount() { mounted = true; },
    dispose() { mounted = false; epoch += 1; reads.clear(); action = undefined; retries.clear(); },
    busy() { return action !== undefined; },
    read(source: string) { const version = (reads.get(source) || 0) + 1; reads.set(source, version); const generation = epoch; return () => mounted && generation === epoch && reads.get(source) === version; },
    invalidateReads() { epoch += 1; reads.clear(); },
    begin(path: string, method: string, input: unknown, idempotent = true) {
      if (!mounted || action) return undefined;
      epoch += 1; reads.clear();
      const body = input === undefined ? undefined : JSON.stringify(input);
      const fingerprint = JSON.stringify([path, method, body]);
      const idempotencyKey = idempotent ? retries.get(fingerprint) || key() : undefined;
      if (idempotencyKey) { retries.set(fingerprint, idempotencyKey); if (retries.size > 20) retries.delete(retries.keys().next().value!); }
      const token = Object.freeze({ path, method, body, idempotencyKey, fingerprint });
      action = token;
      return token;
    },
    current(token: object) { return mounted && action === token; },
    finish(token: { fingerprint: string }, accepted: boolean) { if (action === token) { action = undefined; if (accepted) retries.delete(token.fingerprint); } },
  };
}
