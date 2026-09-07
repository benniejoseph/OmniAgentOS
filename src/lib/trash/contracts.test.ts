import { describe, expect, it } from "vitest";

import {
  buildTrashActionPreviewV1,
  buildTrashEffectReceiptV1,
  buildTrashItemV1,
  trashActionPreviewV1Schema,
  trashEffectReceiptV1Schema,
  trashItemV1Schema,
} from "@/lib/trash/contracts";

const now = "2026-09-07T03:00:00.000Z";
const later = "2026-10-07T03:00:00.000Z";

describe("P9.3 trash and compensation contracts", () => {
  it("binds a restorable item without exposing its snapshot", () => {
    const item = buildTrashItemV1({
      version: "p9.3-trash-item:1",
      trashId: "trash:11111111-1111-4111-8111-111111111111",
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      resourceType: "custom_agent",
      resourceId: "agent-one",
      displayLabel: "Agent One",
      targetSha256: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      compensation: { kind: "exact_restore", handlerId: "trash.restore.custom_agent", limitation: null },
      state: "retained",
      lifecycleRevision: 1,
      trashedAt: now,
      restoreUntil: later,
      restoredAt: null,
      purgedAt: null,
    });
    expect(trashItemV1Schema.parse(item)).toEqual(item);
    expect(JSON.stringify(item)).not.toContain("instructions");
  });

  it("creates expiring exact-target previews", () => {
    const preview = buildTrashActionPreviewV1({
      version: "p9.3-trash-preview:1",
      action: "restore",
      trashId: "trash:11111111-1111-4111-8111-111111111111",
      resourceType: "custom_agent",
      resourceId: "agent-one",
      lifecycleRevision: 1,
      targetSha256: "a".repeat(64),
      effectSummary: "Restore Agent One with its exact prior identity.",
      reversible: true,
      issuedAt: now,
      expiresAt: "2026-09-07T03:10:00.000Z",
    });
    expect(trashActionPreviewV1Schema.parse(preview)).toEqual(preview);
    expect(() => trashActionPreviewV1Schema.parse({ ...preview, targetSha256: "c".repeat(64) })).toThrow();
  });

  it("records revision-fenced final effect receipts", () => {
    const receipt = buildTrashEffectReceiptV1({
      version: "p9.3-trash-effect-receipt:1",
      action: "restore",
      trashId: "trash:11111111-1111-4111-8111-111111111111",
      resourceType: "custom_agent",
      resourceId: "agent-one",
      targetSha256: "a".repeat(64),
      previewSha256: "b".repeat(64),
      beforeState: "retained",
      afterState: "restored",
      beforeRevision: 1,
      afterRevision: 2,
      outcome: "applied",
      affectedResourceIds: ["agent-one"],
      occurredAt: now,
    });
    expect(trashEffectReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(() => trashEffectReceiptV1Schema.parse({ ...receipt, outcome: "rejected" })).toThrow();
  });

  it("requires explicit limitations when compensation is unavailable", () => {
    expect(() => buildTrashItemV1({
      version: "p9.3-trash-item:1",
      trashId: "trash:11111111-1111-4111-8111-111111111111",
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      resourceType: "custom_agent",
      resourceId: "agent-one",
      displayLabel: "Agent One",
      targetSha256: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
      compensation: { kind: "unavailable", handlerId: null, limitation: null },
      state: "retained",
      lifecycleRevision: 1,
      trashedAt: now,
      restoreUntil: later,
      restoredAt: null,
      purgedAt: null,
    })).toThrow("Unavailable compensation requires a limitation");
  });
});
