import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { SqlRow } from "@/lib/db/sql-types";
import type { ResponsibilityBaseline, ResponsibilityObservationReceipt } from "./observation-contracts";
import { createResponsibilityObservationPipeline } from "./observation-state";
import { observationRecord as record, observationOwner as owner, observationNow as now, observationPolicySha256 as policySha256, sourceReadFixture } from "./observation-test-fixtures";
const mocks = vi.hoisted(() => ({ hasDatabaseUrl: vi.fn(), getSql: vi.fn(), ensureDatabaseSchema: vi.fn(), scope: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ ...mocks, runWithDatabaseActorScope: mocks.scope }));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));
import { readResponsibilityObservationHistory, recordResponsibilityObservation, verifiedObservationReceipt } from "./observation-store";
const request = { responsibilityId: record.id, expectedResponsibilityRevision: record.revision, expectedReviewSha256: record.review!.reviewSha256, expectedBaselineRevision: 0, policySha256 };
function draftRow() { return { schema_version: 1, id: record.id, tenant_id: owner.tenantId, actor_id: owner.actorId, revision: record.revision, state: record.state,
  draft_sha256: record.draftSha256, snapshot: record, created_at: record.createdAt, updated_at: record.updatedAt }; }
function baselineRow(value: ResponsibilityBaseline): SqlRow { return { schema_version: 1, tenant_id: owner.tenantId, actor_id: owner.actorId, responsibility_id: record.id,
  revision: value.revision, responsibility_revision: value.target.responsibilityRevision, review_sha256: value.target.reviewSha256, policy_sha256: value.policySha256,
  observation_id: value.observationId, baseline_sha256: value.baselineSha256, snapshot: value, accepted_at: value.acceptedAt }; }
function receiptRow(value: ResponsibilityObservationReceipt): SqlRow { const { plan } = value; return { schema_version: 1, id: plan.observation.id,
  tenant_id: owner.tenantId, actor_id: owner.actorId, responsibility_id: record.id, idempotency_sha256: plan.observation.observationKeySha256, request_sha256: value.requestSha256,
  responsibility_revision: record.revision, review_sha256: record.review!.reviewSha256, expected_baseline_revision: plan.expectedBaselineRevision, policy_sha256: policySha256,
  outcome: plan.outcome, receipt: value, saved_at: value.savedAt }; }
async function receiptFixture() {
  const flow = createResponsibilityObservationPipeline({ record, policySha256, readAuthoritativeSource: async () => sourceReadFixture() });
  const plan = flow.plan(await flow.read({ observationKey: "first", observedAt: now }), null, 0);
  const body = { schemaVersion: 1, request, requestSha256: canonicalJsonSha256({ owner, request }), plan, savedAt: now };
  return verifiedObservationReceipt({ ...body, receiptSha256: canonicalJsonSha256(body) });
}
function database(input: { receipts?: SqlRow[]; baseline?: SqlRow; draft?: SqlRow } = {}) {
  const statements: string[] = [];
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join("?"); statements.push(statement);
    // Match the real managed client: stores cannot issue transaction controls.
    if (/^\s*(?:savepoint|release|rollback|begin|commit)\b/i.test(statement)) throw new Error("Transaction control is owned by the database client.");
    if (statement.includes("SELECT * FROM omni_responsibility_observations")) return input.receipts ?? [];
    if (statement.includes("SELECT * FROM omni_responsibilities")) return [input.draft ?? draftRow()];
    if (statement.includes("SELECT * FROM omni_responsibility_baselines")) return input.baseline ? [input.baseline] : [];
    if (statement.includes("INSERT INTO omni_responsibility_baselines")) return [baselineRow(values[9] as ResponsibilityBaseline)];
    return [];
  }), { transactionScoped: true });
  const transaction = vi.fn((callback: (sql: unknown) => Promise<unknown>) => callback(sql)); mocks.getSql.mockReturnValue({ transaction });
  return { sql, statements, transaction };
}
beforeEach(() => { vi.clearAllMocks(); mocks.hasDatabaseUrl.mockReturnValue(true); mocks.scope.mockImplementation((_tenant: string, _actors: string[], callback: () => Promise<unknown>) => callback()); });
describe("Responsibility observation persistence", () => {
  it("co-commits an admitted source receipt, baseline and typed content-free event under exact owner scope", async () => {
    const db = database(); const read = vi.fn(async () => sourceReadFixture());
    const result = await recordResponsibilityObservation(owner, request, "first", read, now);
    expect(result).toMatchObject({ replayed: false, currentBaseline: { revision: 1 }, receipt: { plan: { outcome: "baseline_established" } } });
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: expect.objectContaining({ actorId: owner.actorId, reviewSha256: request.expectedReviewSha256 }) }), db.sql);
    expect(mocks.scope).toHaveBeenCalledWith(owner.tenantId, [owner.actorId], expect.any(Function));
    expect(db.sql.mock.calls[0].slice(1)).toEqual([JSON.stringify(["responsibility-draft:1", owner.tenantId, owner.actorId])]);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: "responsibility.observation.recorded", payload: expect.objectContaining({ outcome: "baseline_established", deliveryRequested: false, authorityEffect: "none" }) }), { sql: db.sql });
    expect(JSON.stringify(mocks.event.mock.calls)).not.toContain("Budget review"); expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it("replays immutable evidence before fresh source reads and rejects the same key with changed expectations", async () => {
    const receipt = await receiptFixture(); const db = database({ receipts: [receiptRow(receipt)], baseline: baselineRow(receipt.plan.nextBaseline!) });
    const read = vi.fn().mockRejectedValue(new Error("revoked later"));
    expect(await recordResponsibilityObservation(owner, request, "first", read, "2026-11-01T00:00:00.000Z")).toEqual({ receipt, currentBaseline: receipt.plan.nextBaseline, replayed: true });
    expect(read).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    expect(db.statements.some((sql) => sql.includes("SELECT * FROM omni_responsibilities"))).toBe(false);
    await expect(recordResponsibilityObservation(owner, { ...request, expectedBaselineRevision: 1 }, "first", read, now)).rejects.toMatchObject({ code: "responsibility_observation_idempotency_conflict" });
  });
  it("refuses review and baseline CAS drift before source reads", async () => {
    const read = vi.fn(async () => sourceReadFixture()); database();
    await expect(recordResponsibilityObservation(owner, { ...request, expectedReviewSha256: "f".repeat(64) }, "drift", read, now)).rejects.toMatchObject({ code: "responsibility_observation_review_changed" });
    await expect(recordResponsibilityObservation(owner, { ...request, expectedBaselineRevision: 2 }, "drift", read, now)).rejects.toMatchObject({ code: "responsibility_baseline_revision_conflict" });
    expect(read).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("persists safe failed evidence without replacing the last accepted baseline", async () => {
    const prior = await receiptFixture(); const db = database({ baseline: baselineRow(prior.plan.nextBaseline!) });
    const result = await recordResponsibilityObservation(owner, { ...request, expectedBaselineRevision: 1 }, "failed", async () => { throw new Error("private provider body"); }, now);
    expect(result).toMatchObject({ currentBaseline: prior.plan.nextBaseline, receipt: { plan: { outcome: "failed", reasons: ["retrieval_failed"], nextBaseline: null, change: null } } });
    expect(db.statements.some((sql) => sql.includes("UPDATE omni_responsibility_baselines") || sql.includes("INSERT INTO omni_responsibility_baselines"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private provider body");
  });
  it("does not confirm persistence when the co-committed event fails", async () => {
    database(); mocks.event.mockRejectedValueOnce(new Error("event failed"));
    await expect(recordResponsibilityObservation(owner, request, "first", async () => sourceReadFixture(), now)).rejects.toThrow("event failed");
  });
  it("returns bounded history with an honest lower bound and rejects mismatched stored scope", async () => {
    const receipt = await receiptFixture(); database({ receipts: [receiptRow(receipt), receiptRow(receipt)] });
    expect(await readResponsibilityObservationHistory(owner, record.id, 1)).toEqual({ receipts: [receipt], baseline: null, hasMore: true });
    database({ receipts: [{ ...receiptRow(receipt), actor_id: "foreign" }] });
    await expect(readResponsibilityObservationHistory(owner, record.id, 1)).rejects.toMatchObject({ code: "responsibility_storage_invalid" });
  });
  it("rejects forged receipt hashes/targets and unavailable storage without a file fallback", async () => {
    const receipt = await receiptFixture(); expect(() => verifiedObservationReceipt({ ...receipt, receiptSha256: "f".repeat(64) })).toThrow(/could not be verified/);
    const altered = { ...receipt, plan: { ...receipt.plan, outcome: "material_change" } }; const { receiptSha256: _old, ...body } = altered; void _old;
    expect(() => verifiedObservationReceipt({ ...body, receiptSha256: canonicalJsonSha256(body) })).toThrow(/could not be verified/);
    mocks.hasDatabaseUrl.mockReturnValue(false);
    await expect(recordResponsibilityObservation(owner, request, "first", vi.fn(), now)).rejects.toMatchObject({ status: 503 });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });
});
