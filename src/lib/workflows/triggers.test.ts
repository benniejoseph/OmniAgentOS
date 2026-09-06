import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-triggers-"));
  delete process.env.DATABASE_URL;
});

describe("workflow trigger tenant isolation (file mode)", () => {
  it("replays one scoped trigger create without exposing its configuration", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    process.env.TEST_IDEMPOTENT_WEBHOOK_SECRET = "idempotent-test-secret";
    const executionScope = createExecutionScope({
      tenantId: "tenant-trigger-ledger",
      initiatingActorId: "trigger-owner",
      executingPrincipalType: "user",
      executingPrincipalId: "trigger-owner",
      correlationId: "trigger-create-request-1",
      purpose: "workflow.trigger.create",
    });
    const input = {
      tenantId: "tenant-trigger-ledger",
      name: "Private billing webhook",
      authMode: "hmac_sha256" as const,
      secretEnvVar: "TEST_IDEMPOTENT_WEBHOOK_SECRET",
      goalTemplate: "Handle private account {{payload.account_id}}",
      executionScope,
      idempotencyKey: "trigger-create-request-1",
    };

    const first = await triggers.createWorkflowTrigger(input);
    const replay = await triggers.createWorkflowTrigger(input);
    expect(replay.id).toBe(first.id);
    const events = await listStreamEvents(`workflow-trigger:${first.id}`, {
      tenantId: "tenant-trigger-ledger",
    });
    expect(events).toEqual([
      expect.objectContaining({
        actorId: "trigger-owner",
        correlationId: "trigger-create-request-1",
        type: "workflow.trigger.created",
        payload: expect.objectContaining({
          schemaVersion: 1,
          triggerId: first.id,
          configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Private billing webhook");
    expect(JSON.stringify(events)).not.toContain("private account");
  });

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
    const mutationEvents = await listStreamEvents(
      `workflow-trigger:${trigger.id}`,
      { tenantId: "tenant-a" },
    );
    expect(mutationEvents.map((event) => event.type)).toEqual([
      "workflow.trigger.delivery.accepted",
      "workflow.trigger.delivery.enqueued",
      "workflow.trigger.counter.updated",
    ]);
    expect(JSON.stringify(mutationEvents)).not.toContain("example/repository");
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
