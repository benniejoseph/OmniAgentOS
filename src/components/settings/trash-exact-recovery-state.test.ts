import { describe, expect, it } from "vitest";
import { authorizeAppServiceCall, completeAppServiceCall, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildTrashActionPreviewV1, buildTrashEffectReceiptV1, buildTrashItemV1 } from "@/lib/trash/contracts";
import { createAdvancedSettingsGate } from "./settings-advanced-state";
import { readTrashList, readTrashPreview, readTrashReceipt, settingsJsonSha256 } from "./settings-recovery-state";
import { createTrashSelection, exactTrashId, readExactTrashItem, trashReviewMatches } from "./trash-exact-recovery-state";

const at = "2026-10-05T10:00:00.000Z";
const authority = { tenantId: "trash-web-fixture", actorId: "owner@example.test", role: "admin", requestId: "exact-trash-request" };
const context = { tenantId: authority.tenantId, actorId: authority.actorId, role: "admin" as const, source: "session" as const };
function makeItem(index: number) {
  return buildTrashItemV1({ version: "p9.3-trash-item:1", trashId: `trash:11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    tenantId: authority.tenantId, ownerActorId: authority.actorId, resourceType: "mcp_connector", resourceId: `connector-${index}`,
    displayLabel: `Connection ${index}`, targetSha256: "a".repeat(64), snapshotSha256: "b".repeat(64),
    compensation: { kind: "equivalent_action", handlerId: "mcp.restore", limitation: "Reconnect the saved credential after restoration." },
    state: "retained", lifecycleRevision: 1, trashedAt: at, restoreUntil: "2026-10-12T10:00:00.000Z", restoredAt: null, purgedAt: null });
}
const item = makeItem(101);
const { itemSha256: _itemSha256, ...itemBody } = item;
function envelope(record = item) {
  const caller = createRequestMutationAppServiceCaller(new Request(`https://example.test/api/trash/${record.trashId}`, {
    headers: { "x-request-id": authority.requestId },
  }), context, { purpose: "trash.show", causationId: record.trashId });
  const completed = completeAppServiceCall(authorizeAppServiceCall(caller, getAppServiceOperationContract("app.trash.show")), { item: record }, { resourceCount: 1 });
  return { ...completed.data, receipts: [], serviceReceipt: completed.receipt };
}
const retained = { items: [item], listFresh: true, listLoading: false, exactItem: item, exactFresh: true, exactLoading: false, exactCurrent: () => true };

describe("Exact browser Trash recovery", () => {
  it("finds item101 without broadening the first100 list and uses its exact restore preview and receipt", async () => {
    const first100 = await readTrashList({ items: Array.from({ length: 100 }, (_, index) => makeItem(index + 1)) });
    const exact = await readExactTrashItem(envelope(), item.trashId, authority);
    expect(first100.some((row) => row.trashId === exact.trashId)).toBe(false);
    expect(trashReviewMatches({ item: exact, source: "exact" }, { ...retained, items: first100, exactItem: exact })).toBe(true);
    expect(trashReviewMatches({ item: exact, source: "list" }, { ...retained, items: first100 })).toBe(false);
    const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "restore", trashId: item.trashId,
      resourceType: item.resourceType, resourceId: item.resourceId, lifecycleRevision: 1, targetSha256: item.targetSha256,
      effectSummary: "Restore configuration disabled; reconnect credentials.", reversible: true, issuedAt: at, expiresAt: "2026-10-05T10:05:00.000Z" });
    const reviewed = await readTrashPreview({ item: exact, preview }, exact, "restore", Date.parse(at));
    const restored = buildTrashItemV1({ ...itemBody, state: "restored", lifecycleRevision: 2, restoredAt: at });
    const effectReceipt = buildTrashEffectReceiptV1({ version: "p9.3-trash-effect-receipt:1", action: "restore", trashId: item.trashId,
      resourceType: item.resourceType, resourceId: item.resourceId, targetSha256: item.targetSha256, previewSha256: preview.previewSha256,
      beforeState: "retained", afterState: "restored", beforeRevision: 1, afterRevision: 2, outcome: "applied", affectedResourceIds: [item.resourceId], occurredAt: at });
    expect((await readTrashReceipt({ trash: restored, effectReceipt, restoredResourceIds: [item.resourceId], limitation: null }, reviewed, exact)).item.state).toBe("restored");
    expect(first100).toHaveLength(100);
  });

  it("rejects a different requested ID, current owner, tenant, role or request authority", async () => {
    await expect(readExactTrashItem(envelope(), makeItem(102).trashId, authority)).rejects.toThrow("selection");
    for (const changed of [{ actorId: "another@example.test" }, { tenantId: "another-tenant" }, { role: "viewer" }, { requestId: "another-read" }]) {
      await expect(readExactTrashItem(envelope(), item.trashId, { ...authority, ...changed })).rejects.toThrow();
    }
    expect(exactTrashId("../trash")).toBe(false);
    expect(exactTrashId(` ${item.trashId}`)).toBe(false);
  });

  it("rejects altered item digests, extra private fields and forged service evidence", async () => {
    for (const value of [{ ...envelope(), item: { ...item, displayLabel: "altered" } }, { ...envelope(), snapshot: {} },
      { ...envelope(), item: { ...item, credentialCiphertext: "unpublished" } }]) {
      await expect(readExactTrashItem(value, item.trashId, authority)).rejects.toThrow();
    }
    const { receiptSha256: _receiptSha256, ...proof } = envelope().serviceReceipt;
    const wrong = { ...proof, operation: "app.trash.list" };
    await expect(readExactTrashItem({ ...envelope(), serviceReceipt: { ...wrong, receiptSha256: await settingsJsonSha256(wrong) } }, item.trashId, authority)).rejects.toThrow("verified");
  });

  it("returns terminal history truthfully but never authorizes a terminal item for restore", async () => {
    const restored = buildTrashItemV1({ ...itemBody, state: "restored", lifecycleRevision: 2, restoredAt: at });
    expect((await readExactTrashItem(envelope(restored), item.trashId, authority)).state).toBe("restored");
    expect(trashReviewMatches({ item: restored, source: "exact" }, { ...retained, exactItem: restored })).toBe(false);
    await expect(readExactTrashItem({ ...envelope(), receipts: [{}] }, item.trashId, authority)).rejects.toThrow("history");
  });

  it("keeps exact and list freshness independent and never falls back to another selection", () => {
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, items: undefined, listFresh: false, listLoading: true })).toBe(true);
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, exactFresh: false })).toBe(false);
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, exactLoading: true })).toBe(false);
    expect(trashReviewMatches({ item, source: "list" }, { ...retained, listFresh: false })).toBe(false);
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, exactItem: makeItem(102) })).toBe(false);
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, exactItem: buildTrashItemV1({ ...itemBody, lifecycleRevision: 2 }) })).toBe(false);
  });

  it("fences out-of-order exact reads and previews on selection change and replacement", () => {
    const selection = createTrashSelection(), gate = createAdvancedSettingsGate();
    const previous = selection.capture(), first = gate.read("trash-exact");
    selection.invalidate(); const second = gate.read("trash-exact");
    expect(previous()).toBe(false); expect(first.current()).toBe(false); expect(first.signal.aborted).toBe(true);
    const selected = selection.capture(); expect(selected() && second.current()).toBe(true);
    selection.dispose(); expect(selected()).toBe(false); selection.mount(); expect(selected()).toBe(false);
  });

  it("rechecks the exact read at admission even when a retained render still says fresh", () => {
    const gate = createAdvancedSettingsGate(), selection = createTrashSelection();
    const selected = selection.capture(), ticket = gate.read("trash-exact");
    const captured = { ...retained, exactCurrent: () => selected() && ticket.current() };
    expect(trashReviewMatches({ item, source: "exact" }, captured)).toBe(true);
    selection.invalidate();
    expect(captured.exactFresh).toBe(true);
    expect(trashReviewMatches({ item, source: "exact" }, captured)).toBe(false);
    expect(trashReviewMatches({ item, source: "exact" }, { ...retained, exactCurrent: undefined })).toBe(false);
  });

  it("never revives a read across a settings mutation or same-owner authority loss", () => {
    const gate = createAdvancedSettingsGate(), selected = createTrashSelection().capture();
    const beforeMutation = gate.read("trash-exact"); const action = gate.begin(); action.release();
    expect(selected() && beforeMutation.current()).toBe(false);
    const beforeRefresh = gate.read("trash-exact"); gate.availability(false); gate.availability(true);
    expect(selected() && beforeRefresh.current()).toBe(false);
    const beforeReplacement = gate.read("trash-exact"); gate.dispose(); gate.mount();
    expect(selected() && beforeReplacement.current()).toBe(false);
  });
});
