import { describe, expect, it } from "vitest";
import { accountsScopeKey, accountContext, accountDetail, accountList, accountReceipt, createAccountsGate, healthRead, healthReceipt, intelligenceRead, portfolioRead, salesforceRead, salesforceReceipt, workflowRead, workflowReceipt } from "./accounts-workspace-state";
import { buildCustomerAccountRevision, customerAccountId, customerMutationId, projectCustomerAccount360 } from "@/lib/customer-success/contracts";
import { buildDefaultCustomerHealthPolicy } from "@/lib/customer-success/health-contracts";
import { evaluateCustomerHealth } from "@/lib/customer-success/health-engine";
import { buildCustomerSuccessOutcomeReceipt, buildCustomerSuccessWorkflowRunRevision, CUSTOMER_SUCCESS_WORKFLOW_PACK, customerSuccessRunId } from "@/lib/customer-success/workflow-contracts";
import { buildCustomerSuccessAccountIntelligence, buildCustomerSuccessPortfolio } from "@/lib/customer-success/intelligence";

const tenantId = "tenant-accounts-qa", workspaceId = "workspace:accounts-qa", actorId = "actor:11111111-1111-4111-8111-111111111111", at = "2026-10-03T12:00:00.000Z";
const context = { workspaceId, canWrite: true, accessLevel: "manager", authoritySha256: "a".repeat(64) };
function account(revision = 1) {
  const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account" });
  return buildCustomerAccountRevision({ tenantId, workspaceId, accountId, organizationEntityId: "organization:fixture", revision, mutationId: customerMutationId({ accountId, idempotencyKey: `account-${revision}`, operation: revision === 1 ? "account.create" : "account.revise" }), name: "Synthetic account", lifecycle: revision === 1 ? "active" : "at_risk", accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "Synthetic owner" }, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] }, ownerActorId: actorId, revisedByActorId: actorId, revisedAt: at });
}
function dossier() { return projectCustomerAccount360({ account: account(), currentFacts: [], historyCount: 1, evaluatedAt: at }); }
function health() { return evaluateCustomerHealth({ account360: dossier(), revision: 1, evaluationId: `customer-health-evaluation:${"b".repeat(64)}`, evaluatedByActorId: actorId, evaluatedAt: at }); }
const input = { workflowId: "onboarding" as const, objective: "Review first value.", targetDate: null, successCriteria: ["Review exact evidence."], productNames: [], stakeholderIds: [] };
function workflow() {
  const a = account(), definition = CUSTOMER_SUCCESS_WORKFLOW_PACK[0];
  return buildCustomerSuccessWorkflowRunRevision({ tenantId, workspaceId, accountId: a.accountId, accountRevisionId: a.revisionId, accountRevision: 1, accountSha256: a.accountSha256, runId: customerSuccessRunId({ tenantId, workspaceId, accountId: a.accountId, idempotencyKey: "workflow" }), revision: 1, workflowId: "onboarding", definitionSha256: definition.definitionSha256, input, owner: a.accountOwner, ownerActorId: actorId, projectId: "project:synthetic", projectTaskIds: [{ taskKey: "baseline", projectTaskId: "task:synthetic" }], allowedPurposeIds: ["customer_success.account.read"], outcome: buildCustomerSuccessOutcomeReceipt({ status: "in_progress", summary: "", artifactReceipts: [], nextAction: definition.defaultNextAction, recordedByActorId: actorId, recordedAt: at }) });
}
function intelligence() { return buildCustomerSuccessAccountIntelligence({ account360: dossier(), health: null, accountHistory: [account()], factHistory: [], healthHistory: [], workflowRuns: [], workflowHistory: [], meetings: [], approvals: [], generatedAt: at }); }
function salesforce() { return { context, health: { workspaceId, configured: true, connected: false, status: "disconnected", accessMode: "read_only", objectScope: [], cursor: null, lagSeconds: null, actionableError: null, evaluatedAt: at }, findings: [], webhook: { configured: false }, writes: { configured: false, enabled: false, mode: "approval_required", createObjects: [], updateObjects: [], operations: [] }, authorizeUrl: `/api/oauth/salesforce/authorize?returnTo=%2Fapp%2Faccounts&workspaceId=${encodeURIComponent(workspaceId)}` }; }

describe("Accounts independent read and action lifetime", () => {
  it("retains scope across session rechecks but replaces it for authority or external dossier changes", () => {
    const identity = { tenantId, actorId, email: "synthetic@example.test", role: "admin", authenticated: true, authEnabled: true, accountId: account().accountId };
    const ready = { ...identity, status: "ready" }, checking = { ...identity, status: "loading" };
    expect(accountsScopeKey(checking)).toBe(accountsScopeKey(ready));
    for (const change of [{ tenantId: "other" }, { actorId: "other" }, { role: "viewer" }, { authenticated: false }, { accountId: "another-dossier" }]) {
      expect(accountsScopeKey({ ...identity, ...change })).not.toBe(accountsScopeKey(identity));
    }
  });
  it("fences superseded same-source reads but preserves independent optional reads", () => {
    const gate = createAccountsGate(); gate.mount();
    const oldDetail = gate.read("detail"), health = gate.read("health"), latestDetail = gate.read("detail");
    expect(oldDetail()).toBe(false); expect(latestDetail()).toBe(true); expect(health()).toBe(true);
  });
  it("invalidates passive reads synchronously before a write and excludes every competing effect", () => {
    const gate = createAccountsGate(() => "key-1"); gate.mount();
    const read = gate.read("detail"), action = gate.begin("/account", "PATCH", { expectedRevision: 1 });
    expect(read()).toBe(false); expect(gate.busy()).toBe(true);
    expect(gate.begin("/health", "POST", {})).toBeUndefined();
    expect(gate.begin("/salesforce", "POST", undefined, false)).toBeUndefined();
    gate.finish(action!, true); expect(gate.busy()).toBe(false);
    const followUp = gate.read("detail"); expect(followUp()).toBe(true);
  });
  it("freezes JSON and retries only the exact same reviewed path, method and body", () => {
    let key = 0; const gate = createAccountsGate(() => `key-${++key}`); gate.mount();
    const draft = { name: "First" }, first = gate.begin("/accounts", "POST", draft)!;
    draft.name = "Changed"; expect(JSON.parse(first.body!).name).toBe("First"); gate.finish(first, false);
    const exact = gate.begin("/accounts", "POST", { name: "First" })!;
    expect(exact.idempotencyKey).toBe(first.idempotencyKey); gate.finish(exact, false);
    const changed = gate.begin("/accounts", "POST", draft)!;
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey); gate.finish(changed, true);
    const next = gate.begin("/accounts", "POST", draft)!; expect(next.idempotencyKey).not.toBe(changed.idempotencyKey);
  });
  it("never lets an old action settle a remounted scope or clear a newer action", () => {
    const gate = createAccountsGate(() => "key"); gate.mount();
    const old = gate.begin("/a", "POST", {})!; gate.dispose(); gate.mount();
    const newer = gate.begin("/b", "POST", {})!;
    expect(gate.current(old)).toBe(false); gate.finish(old, true); expect(gate.current(newer)).toBe(true);
    const read = gate.read("list"); gate.dispose(); expect(read()).toBe(false);
  });
  it("preserves Salesforce's existing absence of an idempotency header", () => {
    const gate = createAccountsGate(() => { throw new Error("Must not generate CRM keys"); }); gate.mount();
    expect(gate.begin("/crm", "DELETE", undefined, false)?.idempotencyKey).toBeUndefined();
  });
});

describe("Accounts receipt and read boundaries", () => {
  it("accepts empty successes while rejecting absent counts, wrong tenants and duplicate account IDs", () => {
    expect(accountList({ context, accounts: [] }).accounts).toEqual([]);
    expect(() => accountList({ context })).toThrow();
    expect(() => accountList({ context, accounts: [account()] }, "another-tenant")).toThrow();
    expect(() => accountList({ context, accounts: [account(), account()] })).toThrow();
    expect(() => accountContext({ ...context, canWrite: "true" })).toThrow();
  });
  it("binds a dossier to its exact selected account and rejects a malformed nested collection", () => {
    const value = dossier(); expect(accountDetail({ context, account: value }, account().accountId).detail).toEqual(value);
    expect(() => accountDetail({ context, account: value }, "another-account")).toThrow();
    expect(() => accountDetail({ context, account: { ...value, factsByKind: { ...value.factsByKind, renewal: [{}] } } }, account().accountId)).toThrow();
  });
  it("requires the reviewed lifecycle revision and unchanged owner rather than accepting another current snapshot", () => {
    const before = account(), after = account(2), submission = { account: before, lifecycle: "at_risk", workspaceId };
    expect(accountReceipt(after, submission)).toEqual(after);
    expect(() => accountReceipt(before, submission)).toThrow();
    expect(() => accountReceipt({ ...after, revision: 3, revisionId: `${after.accountId}:v3`, previousRevisionId: after.revisionId }, submission)).toThrow();
    expect(() => accountReceipt({ ...after, ownerActorId: "someone-else" }, submission)).toThrow();
  });
  it("binds creation to submitted owner, name, tenant and workspace", () => {
    const value = account(), submission = { name: value.name, lifecycle: value.lifecycle, workspaceId, tenantId, accountOwner: value.accountOwner };
    expect(accountReceipt(value, submission)).toEqual(value);
    expect(() => accountReceipt(value, { ...submission, name: "Different" })).toThrow();
    expect(() => accountReceipt(value, { ...submission, tenantId: "other" })).toThrow();
    expect(() => accountReceipt(value, { ...submission, accountOwner: { ...value.accountOwner, ownerId: "other" } })).toThrow();
  });
  it("keeps missing health unknown and rejects a mismatched evaluation or false healthy-null score", () => {
    const value = health(); expect(value.status).toBe("unknown");
    expect(healthRead({ context, policy: buildDefaultCustomerHealthPolicy(), score: null, history: [] }, account().accountId).score).toBeNull();
    expect(healthReceipt(value, account())).toEqual(value);
    expect(() => healthReceipt(value, account(2))).toThrow();
    expect(() => healthReceipt({ ...value, status: "healthy", scoreBasisPoints: null }, account())).toThrow();
    expect(() => healthRead({ context, policy: value.policy, history: [] }, account().accountId)).toThrow();
  });
  it("accepts production in-progress workflow receipts and binds exact reviewed inputs and definition", () => {
    const value = workflow(), definition = CUSTOMER_SUCCESS_WORKFLOW_PACK[0];
    expect(workflowRead({ context, pack: CUSTOMER_SUCCESS_WORKFLOW_PACK, runs: [value] }, account().accountId).runs[0]).toEqual(value);
    expect(workflowReceipt(value, account(), definition, input)).toEqual(value);
    expect(() => workflowReceipt(value, account(2), definition, input)).toThrow();
    expect(() => workflowReceipt(value, account(), definition, { ...input, objective: "Changed" })).toThrow();
    expect(() => workflowReceipt({ ...value, definitionSha256: "c".repeat(64) }, account(), definition, input)).toThrow();
  });
  it("accepts canonical bounded intelligence and rejects array-shaped fields before rendering", () => {
    const value = intelligence(), portfolio = buildCustomerSuccessPortfolio([value], at);
    expect(intelligenceRead({ context, intelligence: value }, account().accountId)).toEqual(value);
    expect(portfolioRead({ context, portfolio })).toEqual(portfolio);
    expect(() => intelligenceRead({ context, intelligence: { ...value, nextBestAction: { ...value.nextBestAction, title: ["wrong"] } } }, account().accountId)).toThrow();
    expect(() => portfolioRead({ context, portfolio: { ...portfolio, counts: { ...portfolio.counts, urgent: undefined } } })).toThrow();
  });
  it("restricts the OAuth link to the returned workspace and the existing local Salesforce endpoint", () => {
    expect(salesforceRead(salesforce()).health.connected).toBe(false);
    expect(() => salesforceRead({ ...salesforce(), authorizeUrl: "https://provider.invalid/start" })).toThrow();
    expect(() => salesforceRead({ ...salesforce(), authorizeUrl: "/api/oauth/salesforce/authorize?workspaceId=other&returnTo=%2Fapp%2Faccounts" })).toThrow();
    expect(() => salesforceRead({ ...salesforce(), health: { ...salesforce().health, cursor: { objects: { Account: null } } } })).toThrow();
  });
  it("does not invent successful sync counts or provider revocation from incomplete CRM receipts", () => {
    expect(() => salesforceReceipt({}, "sync")).toThrow();
    expect(() => salesforceReceipt({ status: "complete" }, "reconcile")).toThrow();
    expect(salesforceReceipt({ status: "busy", records: 0, pages: 0, advanced: 0, conflicts: 0 }, "sync").message).toContain("did not start another sync");
    expect(salesforceReceipt({ revoked: true, provider: "salesforce", providerRevoked: false, providerRevocation: "failed" }, "disconnect").message).toContain("Provider revocation was not confirmed");
    expect(() => salesforceReceipt({ revoked: true, provider: "salesforce", providerRevoked: true, providerRevocation: "failed" }, "disconnect")).toThrow();
  });
});
