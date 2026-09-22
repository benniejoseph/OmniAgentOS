import { describe, expect, it, vi } from "vitest";

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listNotificationDispositionsService } from "@/lib/app-services/notifications";

const context = {
  tenantId: "tenant-one",
  actorId: "actor-one",
  role: "operator" as const,
  source: "service" as const,
};

describe("notification disposition application service", () => {
  it("binds the read to the initiating actor and returns content-free metadata", async () => {
    const list = vi.fn(async () => [projection()]);
    const result = await listNotificationDispositionsService(
      createAppServiceCaller({ context }),
      { limit: 20, before: "2026-09-22T14:00:00.000Z" },
      { list },
    );

    expect(list).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      limit: 20,
      before: "2026-09-22T14:00:00.000Z",
    });
    expect(result.receipt).toMatchObject({
      operation: "app.notifications.dispositions.list",
      action: "read",
      resourceType: "notification_disposition",
      resourceCount: 1,
    });
    expect(result.data).toMatchObject({
      version: "notification-disposition-projection:1",
      contentIncluded: false,
      dispositions: [{ contentIncluded: false, decisionGrantsAuthority: false }],
    });
    expect(JSON.stringify(result.data)).not.toMatch(
      /ownerActorId|tenantId|occurrenceKey|title|body|message/i,
    );
  });
});

function projection() {
  return Object.freeze({
    dispositionId: `notification_disposition_${"1".repeat(48)}`,
    sourceKind: "delegated_task" as const,
    sourceId: "run-child",
    occurrenceSha256: "2".repeat(64),
    candidateSha256: "3".repeat(64),
    outcome: "defer" as const,
    state: "pending" as const,
    reason: "quiet_hours" as const,
    mustSend: false,
    critical: false,
    policySha256: "4".repeat(64),
    decisionReceiptSha256: "5".repeat(64),
    evaluatedAt: "2026-09-22T13:00:00.000Z",
    dueAt: "2026-09-22T13:15:00.000Z",
    digestDeliveryId: null,
    deliveryKind: null,
    deliveryBindingSha256: null,
    lifecycleRevision: 0,
    updatedAt: "2026-09-22T13:00:00.000Z",
    terminalAt: null,
    contentIncluded: false as const,
    decisionGrantsAuthority: false as const,
  });
}
