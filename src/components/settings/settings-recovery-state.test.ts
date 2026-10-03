import { describe, expect, it } from "vitest";
import { buildTrashActionPreviewV1, buildTrashEffectReceiptV1, buildTrashItemV1 } from "@/lib/trash/contracts";
import { archiveContainsEncryptedAssets, readPortableRestore, readTrashList, readTrashPreview, readTrashReceipt, settingsJsonSha256, settingsTextSha256 } from "./settings-recovery-state";

const at = "2026-10-04T10:00:00.000Z";
const expires = "2026-10-04T10:05:00.000Z";
const item = buildTrashItemV1({
  version: "p9.3-trash-item:1", trashId: "trash:00000000-0000-4000-8000-000000000001", tenantId: "synthetic-tenant", ownerActorId: "synthetic-actor",
  resourceType: "agent_skill", resourceId: "synthetic-skill", displayLabel: "Synthetic skill", targetSha256: "a".repeat(64), snapshotSha256: "b".repeat(64),
  compensation: { kind: "exact_restore", handlerId: "synthetic-handler", limitation: null }, state: "retained", lifecycleRevision: 1,
  trashedAt: at, restoreUntil: "2026-10-11T10:00:00.000Z", restoredAt: null, purgedAt: null,
});
const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "restore", trashId: item.trashId, resourceType: item.resourceType, resourceId: item.resourceId, lifecycleRevision: 1, targetSha256: item.targetSha256, effectSummary: "Restore this synthetic skill.", reversible: true, issuedAt: at, expiresAt: expires });
const effect = buildTrashEffectReceiptV1({ version: "p9.3-trash-effect-receipt:1", action: "restore", trashId: item.trashId, resourceType: item.resourceType, resourceId: item.resourceId, targetSha256: item.targetSha256, previewSha256: preview.previewSha256, beforeState: "retained", afterState: "restored", beforeRevision: 1, afterRevision: 2, outcome: "applied", affectedResourceIds: [item.resourceId], occurredAt: at });
const itemBody = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "itemSha256")) as Omit<typeof item, "itemSha256">;
const restoredItem = buildTrashItemV1({ ...itemBody, state: "restored", lifecycleRevision: 2, restoredAt: at });

describe("Settings recovery previews and receipts", () => {
  it("validates full canonical item and preview hashes using the existing server builders", async () => {
    expect(await readTrashList({ items: [item] })).toEqual([item]);
    expect(await readTrashPreview({ item, preview }, item, "restore", Date.parse(at))).toEqual(preview);
  });
  it("rejects missing lists, duplicate item IDs and altered display metadata", async () => {
    await expect(readTrashList({})).rejects.toThrow("incomplete");
    await expect(readTrashList({ items: [item, item] })).rejects.toThrow("conflicting");
    await expect(readTrashList({ items: [{ ...item, displayLabel: "Changed without new digest" }] })).rejects.toThrow("invalid");
  });
  it("refuses wrong-action, changed-item and expired previews", async () => {
    await expect(readTrashPreview({ item, preview }, item, "purge", Date.parse(at))).rejects.toThrow("changed");
    await expect(readTrashPreview({ item, preview }, item, "restore", Date.parse(expires))).rejects.toThrow("expired");
    const changed = buildTrashItemV1({ ...itemBody, lifecycleRevision: 2 });
    await expect(readTrashPreview({ item: changed, preview }, item, "restore", Date.parse(at))).rejects.toThrow("changed");
  });
  it("accepts a receipt only for the exact preview and terminal resource state", async () => {
    const response = { trash: restoredItem, effectReceipt: effect, restoredResourceIds: [item.resourceId], limitation: null };
    expect((await readTrashReceipt(response, preview, item)).receipt.receiptSha256).toBe(effect.receiptSha256);
    await expect(readTrashReceipt({ ...response, effectReceipt: { ...effect, previewSha256: "c".repeat(64) } }, preview, item)).rejects.toThrow("unconfirmed");
    await expect(readTrashReceipt({ ...response, trash: item }, preview, item)).rejects.toThrow("unconfirmed");
  });
  it("does not present malformed or negative restore counts as zero success", async () => {
    await expect(readPortableRestore({}, { version: 1 })).rejects.toThrow("unconfirmed");
    await expect(readPortableRestore({ restored: { knowledge: -1 } }, { version: 1 })).rejects.toThrow("unconfirmed");
  });
  it("labels the legacy contract without fabricating a v2 verification receipt", async () => {
    const value = await readPortableRestore({ restored: { knowledge: 1, memories: 2, threads: 0, turns: 0, today: 0, projects: 0, skills: 0, agents: 0 } }, { version: 1 });
    expect(value.count).toBe(3); expect(value.verification).toBeUndefined(); expect(value.reauthorization).toBeUndefined();
  });
  it("requires the v2 receipt to bind the archive, tenant, counts and unaltered digest", async () => {
    const names = ["knowledge", "memories", "threads", "today", "projects", "connections", "skills", "agents", "assets"];
    const counts = Object.fromEntries(names.map((name) => [name, 0]));
    const hashes = Object.fromEntries(names.map((name) => [name, "d".repeat(64)]));
    const archive = { version: 2, archiveSha256: "a".repeat(64), manifest: { manifestSha256: "b".repeat(64) }, data: Object.fromEntries(names.map((name) => [name, []])) };
    const body = { schemaVersion: 1, contractId: "asael.portable.restore.v1", archiveSha256: archive.archiveSha256, manifestSha256: archive.manifest.manifestSha256,
      sourceOwnerActorIdSha256: "e".repeat(64), sourceTenantIdSha256: "f".repeat(64), targetOwnerActorIdSha256: "c".repeat(64), targetTenantIdSha256: await settingsTextSha256("synthetic-tenant"),
      ownershipRebound: true, provenancePreserved: true, archiveIntegrityVerified: true, countsVerified: true, hashesVerified: true, declaredCounts: counts, restoredCounts: { ...counts, turns: 0 },
      declaredSectionSha256: hashes, restoredInputSha256: hashes, connectionsReauthorizationRequired: 0, verifiedAt: at };
    const verification = { ...body, receiptSha256: await settingsJsonSha256(body) };
    const response = { restored: { ...counts, turns: 0, verification, connectionsReauthorizationRequired: 0 } };
    expect((await readPortableRestore(response, archive, "synthetic-tenant")).verification).toEqual(verification);
    await expect(readPortableRestore(response, archive, "other-tenant")).rejects.toThrow("workspace");
    await expect(readPortableRestore(response, { ...archive, archiveSha256: "0".repeat(64) }, "synthetic-tenant")).rejects.toThrow("workspace");
    await expect(readPortableRestore({ restored: { ...response.restored, verification: { ...verification, countsVerified: false } } }, archive, "synthetic-tenant")).rejects.toThrow("unconfirmed");
  });
  it("detects encryption only for v2 original assets and treats plain metadata as unencrypted", () => {
    expect(archiveContainsEncryptedAssets({ version: 2, assetEncryption: {}, data: { assets: [{}] } })).toBe(true);
    expect(archiveContainsEncryptedAssets({ version: 2, data: { assets: [] } })).toBe(false);
    expect(archiveContainsEncryptedAssets({ version: 1, assetEncryption: {}, data: { assets: [{}] } })).toBe(false);
  });
});
