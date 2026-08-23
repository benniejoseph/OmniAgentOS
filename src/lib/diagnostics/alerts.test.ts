import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAlertDeliveryDedupeKey,
  dispatchAlertDeliveries,
  enqueueAlertDeliveriesForIncident,
} from "@/lib/diagnostics/alerts";
import type { IncidentRecord } from "@/lib/diagnostics/incidents";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-alert-suppression-"),
  );
  delete process.env.DATABASE_URL;
});

function incident(updatedAt: string): IncidentRecord {
  return {
    id: "incident-1",
    tenantId: "tenant-a",
    fingerprint: "observability:slo:latency",
    componentId: "api",
    severity: "critical",
    status: "open",
    title: "Latency breach",
    message: "p95 is above budget",
    firstSeenAt: "2026-08-23T00:00:00.000Z",
    lastSeenAt: updatedAt,
    occurrenceCount: 3,
    alertTargets: [],
    playbookIds: [],
    metadata: { suppressionMinutes: 30 },
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt,
  };
}

describe("alert delivery suppression", () => {
  it("uses a stable incident window instead of changing timestamps", () => {
    const now = Date.parse("2026-08-23T00:05:00.000Z");
    const first = createAlertDeliveryDedupeKey({
      incident: incident("2026-08-23T00:04:00.000Z"),
      targetId: "webhook",
      now,
    });
    const repeated = createAlertDeliveryDedupeKey({
      incident: incident("2026-08-23T00:10:00.000Z"),
      targetId: "webhook",
      now: now + 10 * 60 * 1_000,
    });
    const nextWindow = createAlertDeliveryDedupeKey({
      incident: incident("2026-08-23T00:36:00.000Z"),
      targetId: "webhook",
      now: now + 31 * 60 * 1_000,
    });

    expect(repeated).toBe(first);
    expect(nextWindow).not.toBe(first);
  });

  it("keeps explicit incident events independently idempotent", () => {
    const record = incident("2026-08-23T00:05:00.000Z");
    expect(
      createAlertDeliveryDedupeKey({
        incident: record,
        eventId: "event-1",
        targetId: "ops",
      }),
    ).toBe("incident-1:event:event-1:ops");
  });

  it("does not requeue a terminal delivery inside its suppression window", async () => {
    const record = incident(new Date().toISOString());
    record.alertTargets = [
      {
        id: "ops",
        name: "Operations ledger",
        channel: "ops",
        status: "ready",
        description: "Persist the alert in the operations ledger.",
      },
    ];
    const [queued] = await enqueueAlertDeliveriesForIncident(record, {
      reason: "incident.observed",
    });
    await expect(
      dispatchAlertDeliveries(1, { tenantId: record.tenantId }),
    ).resolves.toMatchObject({ delivered: 1 });

    const [repeated] = await enqueueAlertDeliveriesForIncident(record, {
      reason: "incident.observed",
    });
    expect(repeated.id).toBe(queued.id);
    expect(repeated.status).toBe("delivered");
  });
});
