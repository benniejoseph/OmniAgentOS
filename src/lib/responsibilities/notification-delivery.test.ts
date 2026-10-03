import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { notificationContext as context, notificationNow as now, notificationOwner as owner, notificationPending, notificationRecord as record, notificationRuntime as runtime } from "./notification-test-fixtures";
import { ResponsibilityError } from "./state";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), clock: vi.fn(), head: vi.fn(), candidate: vi.fn(), runtime: vi.fn(), draft: vi.fn(), sync: vi.fn(), persist: vi.fn(),
  owner: vi.fn(), references: vi.fn(), disposition: vi.fn(), inbox: vi.fn(), quiet: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ ensureDatabaseSchema: vi.fn(), getSql: vi.fn(), hasDatabaseUrl: () => true, runWithDatabaseActorScope: vi.fn(), runWithDatabaseSystemScope: vi.fn() }));
vi.mock("./lifecycle-store", () => ({ withResponsibilityRuntimeTransaction: mocks.transaction, runtimeDatabaseNow: mocks.clock, readRuntimeHead: mocks.runtime, readRuntimeDraft: mocks.draft }));
vi.mock("./notification-store", () => ({ readNotificationAdmission: mocks.head, readNotificationCandidate: mocks.candidate, syncNotificationLifecycleWithSql: mocks.sync, persistNotificationTransition: mocks.persist }));
vi.mock("./notification-references", () => ({ resolveNotificationOwnerContext: mocks.owner, resolveNotificationReferences: mocks.references }));
vi.mock("@/lib/mobile/notification-disposition-store", () => ({ applyNotificationDispositionDecision: mocks.disposition }));
vi.mock("@/lib/mobile/notification-decision-events", () => ({ notificationDecisionExecutionScope: vi.fn(() => ({})) }));
vi.mock("@/lib/today/notifications", () => ({ isQuietHoursActive: mocks.quiet, recordResponsibilityInboxNotificationWithSql: mocks.inbox }));
import { attemptResponsibilityNotification } from "./notification-delivery";
const sql = { transactionScoped: true } as SqlClient;
const dispositionId = `notification_disposition_${"b".repeat(48)}`; const notificationId = `notification_${"a".repeat(48)}`;
let pending: Awaited<ReturnType<typeof notificationPending>>;
beforeEach(async () => {
  vi.clearAllMocks(); pending = await notificationPending();
  mocks.transaction.mockImplementation(async (_owner, work) => work(sql)); mocks.clock.mockResolvedValue(now);
  mocks.head.mockResolvedValue(pending.current); mocks.candidate.mockResolvedValue(pending.candidate); mocks.runtime.mockResolvedValue(runtime); mocks.draft.mockResolvedValue(record);
  mocks.owner.mockResolvedValue(context); mocks.references.mockResolvedValue({ preferences: {}, authorityExpiresAt: null,
    evidence: { projection: { meeting: { startsAt: "2026-10-05T10:00:00.000Z" } } }, binding: canonicalRequestActorBindingFromSecurityContext(context) });
  mocks.quiet.mockReturnValue(false); mocks.inbox.mockResolvedValue({ id: notificationId }); mocks.sync.mockResolvedValue(undefined);
  mocks.persist.mockImplementation(async (_sql, input) => { mocks.head.mockResolvedValue(input.current); if (input.candidate) mocks.candidate.mockResolvedValue(input.candidate); return {}; });
  mocks.disposition.mockImplementation(async (input) => {
    if (input.decision.outcome === "defer") return { applied: true, record: { id: dispositionId, state: "pending" }, deliveryIds: [] };
    const delivery = await input.directDelivery(sql);
    return { applied: true, record: { id: dispositionId, state: "terminal", deliveryKind: delivery.deliveryKind, deliveryBindingSha256: "c".repeat(64) }, deliveryIds: delivery.deliveryIds };
  });
});
describe("Responsibility in-app attempt boundary", () => {
  it("binds one actual inbox row and disposition atomically and repeats without another effect", async () => {
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("delivered");
    expect(mocks.inbox).toHaveBeenCalledWith(sql, { ...owner, responsibilityId: record.id, candidateId: pending.candidate.id, now });
    expect(mocks.persist).toHaveBeenCalledWith(sql, expect.objectContaining({ action: "deliver", current: expect.objectContaining({ used: 1, reserved: 0 }),
      candidate: expect.objectContaining({ notificationId, dispositionId, state: "delivered" }) }));
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("unchanged");
    expect(mocks.inbox).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledWith(owner, expect.any(Function), [owner.actorId, context.actorId]);
  });
  it("holds the immutable candidate for quiet hours with no inbox write", async () => {
    mocks.quiet.mockReturnValue(true);
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("held");
    expect(mocks.inbox).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(sql, expect.objectContaining({ action: "hold", current: expect.objectContaining({ used: 0, reserved: 1 }),
      candidate: expect.objectContaining({ id: pending.candidate.id, reason: "quiet_hours", dispositionId, nextAttemptAt: "2026-10-04T00:15:00.000Z" }) }));
  });
  it("retains the reservation after a rejected ledger transaction and never reports delivery", async () => {
    mocks.inbox.mockRejectedValue(new Error("database connection lost"));
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("held");
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenLastCalledWith(sql, expect.objectContaining({ action: "retry", candidate: expect.objectContaining({ state: "held", reason: "delivery_retry", notificationId: null }) }));
  });
  it("records content-free closure for revoked owner or source without evaluating delivery", async () => {
    mocks.owner.mockRejectedValueOnce(new ResponsibilityError("private owner information", 403, "responsibility_owner_revoked"));
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("closed");
    expect(mocks.disposition).not.toHaveBeenCalled();
    const input = mocks.persist.mock.calls[0][1]; expect(input.candidate).toMatchObject({ state: "blocked", reason: "destination_unavailable", notificationId: null });
    expect(JSON.stringify(input)).not.toContain("private owner");
  });
  it("honors a pause committed before re-reading the candidate and the final clock fence", async () => {
    mocks.sync.mockImplementationOnce(async () => mocks.candidate.mockResolvedValue({ ...pending.candidate, state: "canceled", reason: "owner_paused", nextAttemptAt: null, terminalAt: now }));
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("unchanged"); expect(mocks.references).not.toHaveBeenCalled();
    mocks.candidate.mockResolvedValue(pending.candidate);
    mocks.clock.mockResolvedValueOnce(now).mockResolvedValueOnce(now).mockResolvedValueOnce(now).mockResolvedValue("2026-10-04T01:00:00.000Z");
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("closed");
    expect(mocks.inbox).not.toHaveBeenCalled(); expect(mocks.persist).toHaveBeenLastCalledWith(sql, expect.objectContaining({ action: "expire" }));
  });
  it("keeps a finite already admitted change eligible after checks end, without reopening the runtime", async () => {
    mocks.runtime.mockResolvedValue({ ...runtime, state: "ended", reason: "budget_exhausted" });
    mocks.head.mockResolvedValue({ ...pending.current, state: "draining", reason: "checks_exhausted" });
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("delivered");
    expect(mocks.persist).toHaveBeenLastCalledWith(sql, expect.objectContaining({ current: expect.objectContaining({ state: "draining", used: 1, reserved: 0 }) }));
  });
  it("fences a delivery whose locked meeting starts after preflight but before the inbox insert", async () => {
    mocks.references.mockResolvedValue({ preferences: {}, authorityExpiresAt: null, evidence: { projection: { meeting: { startsAt: "2026-10-04T00:00:01.000Z" } } } });
    mocks.clock.mockResolvedValueOnce(now).mockResolvedValueOnce(now).mockResolvedValueOnce(now).mockResolvedValue("2026-10-04T00:00:01.000Z");
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("closed");
    expect(mocks.inbox).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenLastCalledWith(sql, expect.objectContaining({ action: "block", candidate: expect.objectContaining({ reason: "source_unavailable", notificationId: null }) }));
  });
  it("recovers a committed delivery after response loss without releasing or debiting it again", async () => {
    let transaction = 0;
    mocks.transaction.mockImplementation(async (_owner, work) => {
      transaction++; const result = await work(sql);
      if (transaction === 2) throw new Error("response lost after commit");
      return result;
    });
    expect(await attemptResponsibilityNotification(owner, record.id, pending.candidate.id)).toBe("unchanged");
    expect(mocks.inbox).toHaveBeenCalledOnce(); expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenLastCalledWith(sql, expect.objectContaining({ action: "deliver", current: expect.objectContaining({ used: 1, reserved: 0 }) }));
  });
});
