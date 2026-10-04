import { describe, expect, it } from "vitest";

import { APP_SERVICE_BOUNDARY_VERSION } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildCustomerAccountRevision, buildCustomerFactRevision, customerAccountId, customerFactId, customerMutationId, projectCustomerAccount360 } from "@/lib/customer-success/contracts";
import { buildDefaultCustomerHealthPolicy, customerHealthScoreId } from "@/lib/customer-success/health-contracts";
import { evaluateCustomerHealth } from "@/lib/customer-success/health-engine";
import { buildCustomerSuccessAccountIntelligence } from "@/lib/customer-success/intelligence";
import { initialSalesforceSyncCursor, SALESFORCE_OBJECT_TYPES, SALESFORCE_SYNC_CONTRACT_VERSION } from "@/lib/customer-success/salesforce-contracts";
import { SALESFORCE_CREATE_OBJECTS, SALESFORCE_UPDATE_OBJECTS, SALESFORCE_WRITE_CONTRACT_VERSION, salesforceWriteOperationId } from "@/lib/customer-success/salesforce-write-contracts";
import { buildCustomerSuccessOutcomeReceipt, buildCustomerSuccessWorkflowRunRevision, CUSTOMER_SUCCESS_WORKFLOW_PACK, customerSuccessRunId } from "@/lib/customer-success/workflow-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { nativeCustomerDetailContractSchemas, nativeCustomerHealthQuerySchema, nativeCustomerHealthResponseForScopeSchema, nativeCustomerHealthResponseSchema, nativeCustomerIntelligenceQuerySchema, nativeCustomerIntelligenceResponseForScopeSchema, nativeCustomerIntelligenceResponseSchema, nativeCustomerSalesforceFindingSchema, nativeCustomerSalesforceStatusResponseForWorkspaceSchema, nativeCustomerSalesforceStatusResponseSchema, nativeCustomerSalesforceWriteObservationSchema, nativeCustomerWorkflowsQuerySchema, nativeCustomerWorkflowsResponseForScopeSchema, nativeCustomerWorkflowsResponseSchema } from "./customer-detail-contracts";

const tenantId = "tenant-a", workspaceId = "workspace:tenant-a", now = "2026-10-04T10:00:00.000Z";
const actor = "actor:11111111-1111-4111-8111-111111111111";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account" });
const scope = { tenantId, workspaceId, accountId, requestActorId: "reader@example.test", role: "viewer" };
const context = { scope: "workspace", workspaceId, accessLevel: "reader", canWrite: false, authoritySha256: "a".repeat(64) };
function account360() {
  const account = buildCustomerAccountRevision({ tenantId, workspaceId, accountId, revision: 1, mutationId: customerMutationId({ accountId, idempotencyKey: "account", operation: "account.create" }), name: "Exact account", lifecycle: "active", organizationEntityId: null,
    accountOwner: { ownerKind: "actor", ownerId: actor, displayName: "Other workspace member" }, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] }, ownerActorId: actor, revisedByActorId: actor, revisedAt: now });
  const fact = buildCustomerFactRevision({ tenantId, workspaceId, accountId, factId: customerFactId({ accountId, idempotencyKey: "fact" }), revision: 1, mutationId: customerMutationId({ accountId, idempotencyKey: "fact", operation: "fact.record" }), factKey: "health.overall",
    value: { kind: "health", dimension: "overall", status: "watch", scoreBasisPoints: 5000, summary: "Source <script> is inert text" },
    source: { sourceKind: "manual", sourceId: "source:one", sourceRevisionId: "source:one:v1", sourceRevisionSha256: "b".repeat(64), sourceLabel: "Exact evidence", providerId: null, providerObjectType: null, providerObjectIdSha256: null, permissionBasis: "operator_assertion", allowedPurposeIds: ["customer_success.account.read"], observedAt: now, ingestedAt: now }, owner: { ownerKind: "actor", ownerId: actor, displayName: "Other member" }, confidenceBasisPoints: 8000, validFrom: now, recordedByActorId: actor, recordedAt: now });
  return projectCustomerAccount360({ account, currentFacts: [fact], historyCount: 2, evaluatedAt: now });
}
function health(revision = 1) {
  return evaluateCustomerHealth({ account360: account360(), revision, evaluationId: `customer-health-evaluation:${canonicalJsonSha256({ revision })}`, evaluatedByActorId: actor, evaluatedAt: now });
}
function healthBody() { return { context, policy: buildDefaultCustomerHealthPolicy(), score: health(2), history: [health(1)] }; }
function intelligenceBody() {
  const source = account360();
  return { context, intelligence: buildCustomerSuccessAccountIntelligence({ account360: source, health: null, accountHistory: [source.account], factHistory: source.facts.map((view) => view.fact), healthHistory: [], workflowRuns: [], workflowHistory: [], meetings: [], approvals: [], generatedAt: now }) };
}
function run(overrides: Partial<Parameters<typeof buildCustomerSuccessWorkflowRunRevision>[0]> = {}) {
  const source = account360(), definition = CUSTOMER_SUCCESS_WORKFLOW_PACK[0];
  return buildCustomerSuccessWorkflowRunRevision({ tenantId, workspaceId, accountId, accountRevisionId: source.account.revisionId, accountRevision: 1, accountSha256: source.account.accountSha256,
    runId: customerSuccessRunId({ tenantId, workspaceId, accountId, idempotencyKey: "run" }), revision: 1, workflowId: definition.workflowId, definitionSha256: definition.definitionSha256,
    input: { workflowId: "onboarding", objective: "Review cited evidence", targetDate: null, successCriteria: ["Owned review"], productNames: [], stakeholderIds: [] }, owner: { ownerKind: "actor", ownerId: actor, displayName: "Other member" }, ownerActorId: actor, projectId: "project:one", projectTaskIds: [{ taskKey: "baseline", projectTaskId: "task:one" }], allowedPurposeIds: ["customer_success.account.read"],
    outcome: buildCustomerSuccessOutcomeReceipt({ status: "in_progress", summary: "", artifactReceipts: [], nextAction: definition.defaultNextAction, recordedByActorId: actor, recordedAt: now }), ...overrides });
}
function workflowsBody() { return { context, pack: CUSTOMER_SUCCESS_WORKFLOW_PACK, runs: [run()] }; }
function response<T extends object>(body: T, operation: Parameters<typeof getAppServiceOperationContract>[0], resourceCount: number) {
  const operationContract = getAppServiceOperationContract(operation);
  const receipt = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, operation, action: operationContract.action, resourceType: operationContract.resourceType, eventContract: operationContract.eventContract, accessMode: "read", authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: null }), idempotencyKeySha256: null, outcomeSha256: canonicalJsonSha256(body), resourceCount, occurredAt: now };
  return { ...body, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
function finding(index = 0) {
  const findingSha256 = canonicalJsonSha256({ index });
  return { findingId: `salesforce-finding:${findingSha256}`, objectType: "Account", externalIdSha256: "c".repeat(64), localRevisionId: `salesforce-revision:${"a".repeat(64)}`, remoteRevisionId: null, findingKind: "missing_remote", findingSha256, observedAt: now };
}
function writeObservation(index = 0) {
  const toolExecutionId = `execution:${index}`;
  return { operationId: salesforceWriteOperationId(toolExecutionId), toolExecutionId, toolId: "app.customer_accounts.salesforce.contact.create", objectType: "Contact", action: "create", customerAccountId: accountId, providerRecordIdSha256: null, requestSha256: "a".repeat(64), expectedTargetStateSha256: "b".repeat(64), state: "prepared", providerAcknowledgementSha256: null, observedTargetStateSha256: null, verificationReasonCode: null, commit: null, attemptCount: 1, lastAttemptAt: now, completedAt: null, createdAt: now, updatedAt: now };
}
function statusBody() {
  return { context, health: { schemaVersion: 1, contractVersion: SALESFORCE_SYNC_CONTRACT_VERSION, configured: true, connected: true, connectionId: `salesforce-connection:${"d".repeat(64)}`, workspaceId, status: "degraded", accessMode: "read_only", objectScope: [...SALESFORCE_OBJECT_TYPES], purposeScope: ["customer_success.account.read", "customer_success.crm_sync"], cursor: initialSalesforceSyncCursor(), lagSeconds: null, lastSuccessfulSyncAt: null, lastWebhookAt: null, lastReplayIdSha256: null, actionableError: null, evaluatedAt: now }, findings: [finding()], writes: { configured: false, enabled: false, mode: "approval_required", createObjects: [...SALESFORCE_CREATE_OBJECTS], updateObjects: [...SALESFORCE_UPDATE_OBJECTS], operations: [writeObservation()] }, authorizeUrl: `/api/oauth/salesforce/authorize?returnTo=${encodeURIComponent("/app/accounts")}&workspaceId=${encodeURIComponent(workspaceId)}`, webhook: { endpoint: "/api/webhooks/salesforce", signature: "hmac-sha256-v1", configured: false } };
}

describe("standalone native Accounts detail read candidates", () => {
  it("contains only four typed query/response pairs and no write capability", () => {
    expect(Object.keys(nativeCustomerDetailContractSchemas)).toEqual(["NativeCustomerHealthQuery", "NativeCustomerIntelligenceQuery", "NativeCustomerWorkflowsQuery", "NativeCustomerSalesforceStatusQuery", "NativeCustomerHealthResponse", "NativeCustomerIntelligenceResponse", "NativeCustomerWorkflowsResponse", "NativeCustomerSalesforceStatusResponse"]);
  });
  it("matches the four existing GET limits without accepting mutation fields", () => {
    expect(nativeCustomerHealthQuerySchema.parse({})).toEqual({ historyLimit: 20 });
    expect(nativeCustomerIntelligenceQuerySchema.parse({})).toEqual({ historyLimit: 100, timelineLimit: 100 });
    expect(nativeCustomerWorkflowsQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const [schema, key, max] of [[nativeCustomerHealthQuerySchema, "historyLimit", 100], [nativeCustomerIntelligenceQuerySchema, "historyLimit", 250], [nativeCustomerIntelligenceQuerySchema, "timelineLimit", 250], [nativeCustomerWorkflowsQuerySchema, "limit", 100]] as const) {
      expect(schema.safeParse({ [key]: max }).success).toBe(true);
      for (const invalid of [0, -1, max + 1, 1.5, "20"]) expect(schema.safeParse({ [key]: invalid }).success).toBe(false);
      expect(schema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    }
  });
  it("preserves exact health evidence and independently read current/history revisions", () => {
    const result = nativeCustomerHealthResponseForScopeSchema(scope).parse(response(healthBody(), "app.customer_accounts.health.show", 1));
    expect(result.score?.revision).toBe(2); expect(result.history[0].revision).toBe(1);
    expect(result.score?.factors[0].evidence[0].factRevisionId).toBe(account360().facts[0].fact.factRevisionId);
    const empty = { context, policy: buildDefaultCustomerHealthPolicy(), score: null, history: [] };
    expect(nativeCustomerHealthResponseSchema.parse(response(empty, "app.customer_accounts.health.show", 0)).score).toBeNull();
    expect(nativeCustomerHealthResponseSchema.safeParse(response(empty, "app.customer_accounts.health.show", 1)).success).toBe(false);
  });
  it("bounds health history and rejects duplicate revisions instead of implying complete history", () => {
    const body = { ...healthBody(), history: Array.from({ length: 100 }, (_, index) => health(index + 1)) };
    expect(nativeCustomerHealthResponseSchema.safeParse(response(body, "app.customer_accounts.health.show", 1)).success).toBe(true);
    expect(nativeCustomerHealthResponseSchema.safeParse(response({ ...body, history: [...body.history, health(101)] }, "app.customer_accounts.health.show", 1)).success).toBe(false);
    expect(nativeCustomerHealthResponseSchema.safeParse(response({ ...body, history: [health(1), health(1)] }, "app.customer_accounts.health.show", 1)).success).toBe(false);
  });
  it("rejects a validly rehashed health revision from another tenant", () => {
    const body = healthBody(), score = body.history[0];
    score.tenantId = "foreign"; score.scoreId = customerHealthScoreId(score); score.scoreRevisionId = `${score.scoreId}:v1`;
    const { scoreSha256: _sha, ...rest } = score; score.scoreSha256 = canonicalJsonSha256(rest);
    expect(nativeCustomerHealthResponseForScopeSchema(scope).safeParse(response(body, "app.customer_accounts.health.show", 1)).success).toBe(false);
  });
  it("keeps unknown intelligence and suggested next action separate from execution authority", () => {
    const result = nativeCustomerIntelligenceResponseForScopeSchema(scope).parse(response(intelligenceBody(), "app.customer_accounts.intelligence.show", 1));
    expect(result.intelligence.portfolio.health.current).toBe(false);
    expect(result.intelligence.nextBestAction.authoritative).toBe(false);
    const body = intelligenceBody();
    const invalid = { ...body.intelligence.nextBestAction, authoritative: true };
    expect(nativeCustomerIntelligenceResponseSchema.safeParse(response({ ...body, intelligence: { ...body.intelligence, nextBestAction: invalid } }, "app.customer_accounts.intelligence.show", 1)).success).toBe(false);
  });
  it("requires identical duplicate next-action projections even after all digests are rehashed", () => {
    const body = structuredClone(intelligenceBody()), action = body.intelligence.nextBestAction;
    action.title = "Changed action"; const { recommendationSha256: _actionSha, ...actionBody } = action; action.recommendationSha256 = canonicalJsonSha256(actionBody);
    const { projectionSha256: _projectionSha, ...projectionBody } = body.intelligence; body.intelligence.projectionSha256 = canonicalJsonSha256(projectionBody);
    expect(nativeCustomerIntelligenceResponseSchema.safeParse(response(body, "app.customer_accounts.intelligence.show", 1)).success).toBe(false);
  });
  it("accepts the exact immutable workflow pack and inspectable in-progress outcome", () => {
    const result = nativeCustomerWorkflowsResponseForScopeSchema(scope).parse(response(workflowsBody(), "app.customer_accounts.workflows.list", 1));
    expect(result.runs[0].outcome.status).toBe("in_progress");
    expect(result.pack.every((definition) => !definition.externalActionPolicy.directExternalEffectsAllowed)).toBe(true);
    expect(result.runs[0].ownerActorId).toBe(actor);
  });
  it("rejects foreign runs, duplicate identities and substituted published definitions", () => {
    const body = workflowsBody();
    expect(nativeCustomerWorkflowsResponseForScopeSchema(scope).safeParse(response({ ...body, runs: [run({ tenantId: "foreign" })] }, "app.customer_accounts.workflows.list", 1)).success).toBe(false);
    expect(nativeCustomerWorkflowsResponseSchema.safeParse(response({ ...body, runs: [run(), run()] }, "app.customer_accounts.workflows.list", 2)).success).toBe(false);
    const pack = structuredClone(body.pack), definition = pack[0];
    const changed = { ...definition, defaultNextAction: "Changed instruction" };
    const { definitionSha256: _sha, ...definitionBody } = changed;
    expect(nativeCustomerWorkflowsResponseSchema.safeParse(response({ ...body, pack: [{ ...changed, definitionSha256: canonicalJsonSha256(definitionBody) }, ...pack.slice(1)] }, "app.customer_accounts.workflows.list", 1)).success).toBe(false);
  });
  it("fences request actor, tenant, role, workspace and exact account for all receipt-bearing reads", () => {
    const cases = [
      [nativeCustomerHealthResponseForScopeSchema, response(healthBody(), "app.customer_accounts.health.show", 1)],
      [nativeCustomerIntelligenceResponseForScopeSchema, response(intelligenceBody(), "app.customer_accounts.intelligence.show", 1)],
      [nativeCustomerWorkflowsResponseForScopeSchema, response(workflowsBody(), "app.customer_accounts.workflows.list", 1)],
    ] as const;
    for (const [schema, value] of cases) for (const changed of [{ requestActorId: "foreign@example.test" }, { tenantId: "foreign" }, { role: "admin" }, { workspaceId: "workspace:foreign" }, { accountId: `customer-account:${"f".repeat(64)}` }]) expect(schema({ ...scope, ...changed }).safeParse(value).success).toBe(false);
  });
  it("rejects substituted bodies, foreign read-operation receipts and nested extra fields", () => {
    const body = healthBody();
    expect(nativeCustomerHealthResponseSchema.safeParse(response(body, "app.customer_accounts.intelligence.show", 1)).success).toBe(false);
    const value = response(body, "app.customer_accounts.health.show", 1);
    expect(nativeCustomerHealthResponseSchema.safeParse({ ...value, history: [] }).success).toBe(false);
    expect(nativeCustomerHealthResponseSchema.safeParse(response({ ...body, context: { ...context, accessToken: "untrusted" } }, "app.customer_accounts.health.show", 1)).success).toBe(false);
    expect(nativeCustomerWorkflowsResponseSchema.safeParse(response({ ...workflowsBody(), runs: [{ ...run(), execute: true }] }, "app.customer_accounts.workflows.list", 1)).success).toBe(false);
  });
  it("keeps a prepared Salesforce attempt inspection-only with no invented receipt", () => {
    const result = nativeCustomerSalesforceStatusResponseForWorkspaceSchema(workspaceId).parse(statusBody());
    expect(result.writes.operations[0]).toMatchObject({ state: "prepared", attemptCount: 1, commit: null, completedAt: null });
    expect("serviceReceipt" in result).toBe(false);
    expect(nativeCustomerSalesforceStatusResponseForWorkspaceSchema("workspace:other").safeParse(statusBody()).success).toBe(false);
    expect(nativeCustomerSalesforceWriteObservationSchema.safeParse({ ...writeObservation(), state: "verified" }).success).toBe(false);
    expect(nativeCustomerSalesforceWriteObservationSchema.safeParse({ ...writeObservation(), objectType: "Account" }).success).toBe(false);
  });
  it("binds terminal Salesforce child receipts to exact operation and target evidence", () => {
    const observed = writeObservation();
    const commit = { schemaVersion: 1, contractVersion: SALESFORCE_WRITE_CONTRACT_VERSION, operationId: observed.operationId, toolId: observed.toolId, objectType: observed.objectType, action: observed.action, providerRecordIdSha256: "c".repeat(64), providerModifiedAt: now, providerAcknowledgement: "provider_response", providerAcknowledgementId: `salesforce_ack_${"d".repeat(48)}`, providerAcknowledgementSha256: "d".repeat(64), expectedTargetStateSha256: observed.expectedTargetStateSha256, observedTargetStateSha256: observed.expectedTargetStateSha256, verificationState: "verified", verificationReasonCode: "state_matched" };
    const terminal = { ...observed, state: "verified", commit, completedAt: now, providerRecordIdSha256: commit.providerRecordIdSha256, providerAcknowledgementSha256: commit.providerAcknowledgementSha256, observedTargetStateSha256: commit.observedTargetStateSha256, verificationReasonCode: commit.verificationReasonCode };
    expect(nativeCustomerSalesforceWriteObservationSchema.safeParse(terminal).success).toBe(true);
    expect(nativeCustomerSalesforceWriteObservationSchema.safeParse({ ...terminal, commit: { ...commit, operationId: salesforceWriteOperationId("other") } }).success).toBe(false);
    expect(nativeCustomerSalesforceWriteObservationSchema.safeParse({ ...terminal, expectedTargetStateSha256: "e".repeat(64) }).success).toBe(false);
  });
  it("bounds Salesforce findings and write observations, preserves unknown lag and rejects unsafe counters", () => {
    const body = { ...statusBody(), findings: Array.from({ length: 50 }, (_, index) => finding(index)) };
    body.writes.operations = Array.from({ length: 25 }, (_, index) => writeObservation(index));
    expect(nativeCustomerSalesforceStatusResponseSchema.parse(body).health.lagSeconds).toBeNull();
    expect(nativeCustomerSalesforceStatusResponseSchema.safeParse({ ...body, findings: [...body.findings, finding(51)] }).success).toBe(false);
    expect(nativeCustomerSalesforceStatusResponseSchema.safeParse({ ...body, writes: { ...body.writes, operations: [...body.writes.operations, writeObservation(26)] } }).success).toBe(false);
    body.health.cursor.objects.Account.recordsSettled = Number.MAX_SAFE_INTEGER + 1;
    expect(nativeCustomerSalesforceStatusResponseSchema.safeParse(body).success).toBe(false);
  });
  it("treats all provider URLs as inert metadata and rejects substituted OAuth destinations and extra secrets", () => {
    const body = statusBody(); body.health.cursor.objects.Account.nextRecordsPath = "/services/data/v60.0/query/opaque-cursor";
    expect(nativeCustomerSalesforceStatusResponseSchema.safeParse(body).success).toBe(true);
    for (const authorizeUrl of ["javascript:alert(1)", "https://example.test/oauth", `${body.authorizeUrl}&workspaceId=other`]) expect(nativeCustomerSalesforceStatusResponseSchema.safeParse({ ...body, authorizeUrl }).success).toBe(false);
    expect(nativeCustomerSalesforceStatusResponseSchema.safeParse({ ...body, webhook: { ...body.webhook, secret: "forbidden" } }).success).toBe(false);
    expect(nativeCustomerSalesforceFindingSchema.safeParse({ ...finding(), findingId: `salesforce-finding:${"f".repeat(64)}` }).success).toBe(false);
    expect(nativeCustomerSalesforceFindingSchema.safeParse({ ...finding(), observedAt: "2026-10-04T11:00:00.000+01:00" }).success).toBe(false);
  });
});
