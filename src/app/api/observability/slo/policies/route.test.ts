import { describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({
  authorizeRequest: vi.fn(async () => {
    throw new Error("Not signed in.");
  }),
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: guard.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

const { POST } = await import("@/app/api/observability/slo/policies/route");
const { SLO_METRICS, getDefaultObservabilitySloPolicies } = await import(
  "@/lib/observability/slo-policy-store"
);

function upsert(metric: string) {
  return POST(
    new Request("https://asael.test/api/observability/slo/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "upsert_policy",
        policy: {
          id: "custom_policy",
          name: "Custom policy",
          metric,
          comparator: "greater_than",
          warningThreshold: 1,
          criticalThreshold: 2,
          unit: "count",
          enabled: true,
        },
      }),
    }),
  );
}

describe("saving an SLO policy", () => {
  it("accepts every metric the monitor evaluates, and no other", async () => {
    // A valid policy passes validation and reaches authorization.
    for (const metric of SLO_METRICS) {
      expect([metric, (await upsert(metric)).status]).toEqual([metric, 403]);
    }
    expect(guard.authorizeRequest).toHaveBeenCalledTimes(SLO_METRICS.length);
    expect((await upsert("latencyP99Ms")).status).toBe(400);
    expect(guard.authorizeRequest).toHaveBeenCalledTimes(SLO_METRICS.length);
    // Every default can be saved back as it is.
    expect(SLO_METRICS).toEqual(
      expect.arrayContaining(getDefaultObservabilitySloPolicies().map((policy) => policy.metric)),
    );
  });
});
