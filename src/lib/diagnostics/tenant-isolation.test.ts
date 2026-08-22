import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-diagnostics-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
});

describe("operational tenant isolation (file mode)", () => {
  it("keeps legacy unowned incidents in the default tenant", async () => {
    const now = new Date().toISOString();
    await writeFile(
      path.join(dataDir, "incidents.json"),
      JSON.stringify({
        incidents: [{
          id: "legacy-incident",
          fingerprint: "legacy:fingerprint",
          componentId: "database",
          severity: "warning",
          status: "open",
          title: "Legacy incident",
          message: "Legacy default-tenant incident",
          firstSeenAt: now,
          lastSeenAt: now,
          occurrenceCount: 1,
          alertTargets: [],
          playbookIds: [],
          metadata: {},
          createdAt: now,
          updatedAt: now,
        }],
        events: [],
      }),
    );
    const incidents = await import("@/lib/diagnostics/incidents");
    expect(
      await incidents.listIncidents({ tenantId: "tenant-b", status: "all" }),
    ).toEqual([]);
    expect(
      (await incidents.listIncidents({ tenantId: "default", status: "all" }))[0]?.id,
    ).toBe("legacy-incident");
  });

  it("partitions incidents and alert deliveries with identical logical keys", async () => {
    const incidents = await import("@/lib/diagnostics/incidents");
    const alerts = await import("@/lib/diagnostics/alerts");
    const tenantA = await incidents.upsertIncidentFromSignal({
      tenantId: "tenant-a",
      fingerprint: "shared:fingerprint",
      componentId: "database",
      severity: "critical",
      title: "Tenant A database",
      message: "Tenant A database signal",
    });
    const tenantB = await incidents.upsertIncidentFromSignal({
      tenantId: "tenant-b",
      fingerprint: "shared:fingerprint",
      componentId: "database",
      severity: "warning",
      title: "Tenant B database",
      message: "Tenant B database signal",
    });

    await alerts.enqueueAlertDeliveriesForIncident(tenantA.incident, {
      eventId: tenantA.event.id,
    });
    await alerts.enqueueAlertDeliveriesForIncident(tenantB.incident, {
      eventId: tenantB.event.id,
    });

    const [tenantAIncidents, tenantBIncidents, tenantAAlerts, tenantBAlerts] =
      await Promise.all([
        incidents.listIncidents({ tenantId: "tenant-a", status: "all" }),
        incidents.listIncidents({ tenantId: "tenant-b", status: "all" }),
        alerts.listAlertDeliveries({ tenantId: "tenant-a" }),
        alerts.listAlertDeliveries({ tenantId: "tenant-b" }),
      ]);

    expect(tenantAIncidents.map((incident) => incident.id)).toContain(
      tenantA.incident.id,
    );
    expect(tenantAIncidents.map((incident) => incident.id)).not.toContain(
      tenantB.incident.id,
    );
    expect(tenantBIncidents.map((incident) => incident.id)).toContain(
      tenantB.incident.id,
    );
    expect(tenantAAlerts.every((delivery) => delivery.tenantId === "tenant-a")).toBe(true);
    expect(tenantBAlerts.every((delivery) => delivery.tenantId === "tenant-b")).toBe(true);
  });

  it("partitions SLO policy state by tenant", async () => {
    const policies = await import("@/lib/observability/slo-policy-store");
    const basePolicy = policies.getDefaultObservabilitySloPolicies()[0];
    await writeFile(
      path.join(dataDir, "observability-slo-policies.json"),
      JSON.stringify({
        policies: [{ ...basePolicy, name: "Legacy default error budget" }],
      }),
    );
    expect(
      (await policies.getObservabilitySloPolicy(basePolicy.id, {
        tenantId: "default",
      }))?.name,
    ).toBe("Legacy default error budget");
    expect(
      (await policies.getObservabilitySloPolicy(basePolicy.id, {
        tenantId: "tenant-b",
      }))?.name,
    ).not.toBe("Legacy default error budget");

    await policies.saveObservabilitySloPolicy({
      ...basePolicy,
      tenantId: "tenant-a",
      name: "Tenant A error budget",
    });
    await policies.saveObservabilitySloPolicy({
      ...basePolicy,
      tenantId: "tenant-b",
      name: "Tenant B error budget",
    });

    const tenantA = await policies.getObservabilitySloPolicy(basePolicy.id, {
      tenantId: "tenant-a",
    });
    const tenantB = await policies.getObservabilitySloPolicy(basePolicy.id, {
      tenantId: "tenant-b",
    });
    expect(tenantA?.name).toBe("Tenant A error budget");
    expect(tenantB?.name).toBe("Tenant B error budget");
  });
});
