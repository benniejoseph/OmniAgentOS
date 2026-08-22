import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-triggers-"));
  delete process.env.DATABASE_URL;
});

describe("workflow trigger tenant isolation (file mode)", () => {
  it("lists only triggers owned by the requested tenant", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    process.env.TENANT_A_WEBHOOK_SECRET = "tenant-a-test-secret";
    process.env.TENANT_B_WEBHOOK_SECRET = "tenant-b-test-secret";
    const tenantA = await triggers.createWorkflowTrigger({
      tenantId: "tenant-a",
      name: "Tenant A webhook",
      authMode: "hmac_sha256",
      secretEnvVar: "TENANT_A_WEBHOOK_SECRET",
    });
    const tenantB = await triggers.createWorkflowTrigger({
      tenantId: "tenant-b",
      name: "Tenant B webhook",
      authMode: "hmac_sha256",
      secretEnvVar: "TENANT_B_WEBHOOK_SECRET",
    });

    const tenantATriggers = await triggers.listWorkflowTriggers(50, {
      tenantId: "tenant-a",
    });
    const tenantBTriggers = await triggers.listWorkflowTriggers(50, {
      tenantId: "tenant-b",
    });

    expect(tenantATriggers.map((trigger) => trigger.id)).toEqual([tenantA.id]);
    expect(tenantBTriggers.map((trigger) => trigger.id)).toEqual([tenantB.id]);
    expect(
      await triggers.getWorkflowTrigger(tenantB.id, { tenantId: "tenant-a" }),
    ).toBeNull();
  });

  it("blocks unauthenticated triggers in production", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const legacyTrigger = await triggers.createWorkflowTrigger({
      tenantId: "tenant-a",
      name: "Legacy unauthenticated webhook",
      authMode: "none",
    });
    const previous = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      await expect(
        triggers.dispatchWorkflowTrigger({
          triggerId: legacyTrigger.id,
          bodyText: "{}",
          headers: {},
        }),
      ).resolves.toMatchObject({
        event: {
          status: "rejected",
          error: "Unauthenticated workflow triggers are disabled in production.",
        },
      });
      await expect(
        triggers.createWorkflowTrigger({
          tenantId: "tenant-a",
          name: "Unsafe production webhook",
          authMode: "none",
        }),
      ).rejects.toThrow("disabled in production");
    } finally {
      if (previous === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = previous;
      }
    }
  });

  it("accepts standard GitHub signatures and deduplicates delivery ids", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const secret = "github-webhook-test-secret";
    process.env.TEST_GITHUB_WEBHOOK_SECRET = secret;
    const trigger = await triggers.createWorkflowTrigger({
      tenantId: "tenant-a",
      name: "GitHub webhook",
      source: "github",
      authMode: "hmac_sha256",
      secretEnvVar: "TEST_GITHUB_WEBHOOK_SECRET",
      goalTemplate: "Handle {{event.type}} for {{payload.repository.full_name}}",
    });
    const bodyText = JSON.stringify({
      action: "opened",
      repository: { full_name: "example/repository" },
    });
    const signature = `sha256=${createHmac(
      "sha256",
      secret,
    )
      .update(bodyText)
      .digest("hex")}`;
    const input = {
      triggerId: trigger.id,
      bodyText,
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
    };

    const first = await triggers.dispatchWorkflowTrigger(input);
    const replay = await triggers.dispatchWorkflowTrigger(input);

    expect(first.event.status).toBe("enqueued");
    expect(first.workflow?.run.id).toMatch(/^wf_/);
    expect(replay.replayed).toBe(true);
    expect(replay.event.workflowRunId).toBe(first.workflow?.run.id);
  });

  it("increments trigger counters without losing concurrent deliveries", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const secret = "concurrent-webhook-test-secret";
    process.env.TEST_CONCURRENT_WEBHOOK_SECRET = secret;
    const trigger = await triggers.createWorkflowTrigger({
      tenantId: "tenant-a",
      name: "Concurrent webhook",
      source: "github",
      authMode: "hmac_sha256",
      secretEnvVar: "TEST_CONCURRENT_WEBHOOK_SECRET",
    });
    const bodyText = JSON.stringify({ action: "synchronize" });
    const signature = `sha256=${createHmac("sha256", secret)
      .update(bodyText)
      .digest("hex")}`;
    const deliveryCount = 6;

    const results = await Promise.all(
      Array.from({ length: deliveryCount }, (_, index) =>
        triggers.dispatchWorkflowTrigger({
          triggerId: trigger.id,
          bodyText,
          headers: {
            "x-hub-signature-256": signature,
            "x-github-delivery": `concurrent-delivery-${index}`,
            "x-github-event": "push",
          },
        }),
      ),
    );

    expect(results.every((result) => result.event.status === "enqueued")).toBe(true);
    await expect(
      triggers.getWorkflowTrigger(trigger.id, { tenantId: "tenant-a" }),
    ).resolves.toMatchObject({
      triggerCount: deliveryCount,
      failureCount: 0,
    });
  });
});
