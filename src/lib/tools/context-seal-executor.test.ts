import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import { injectionCanaryToken } from "@/lib/security/context-seal";
import type { SecurityContext } from "@/lib/security/types";

const runtime = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  recordRuntimeEventSafely: runtime.record,
}));

vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

import {
  executeGovernedTool,
  INJECTION_CANARY_LATCHED_REASON,
  INJECTION_CANARY_REASON,
} from "@/lib/tools/executor";
import { saveToolExecution } from "@/lib/tools/audit-store";

const TENANT = "tenant-canary";
const context: SecurityContext = {
  tenantId: TENANT,
  actorId: "owner-canary",
  role: "admin",
  source: "session",
};

let runCount = 0;
function nextRunId() {
  runCount += 1;
  return `run-canary-${runCount}`;
}

function write(content: string, options: {
  agentRunId?: string;
  dryRun?: boolean;
  approved?: boolean;
  tenantContext?: SecurityContext;
} = {}) {
  return executeGovernedTool({
    toolId: "memory.write",
    input: { title: "Forwarded notes", content },
    dryRun: options.dryRun ?? true,
    approved: options.approved,
    context: options.tenantContext ?? context,
    agentRunId: options.agentRunId,
  });
}

async function eventsFor(executionId: string, tenantId = TENANT) {
  return listStreamEvents(`tool_execution:${executionId}`, { tenantId });
}

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-injection-canary-"),
  );
  delete process.env.DATABASE_URL;
  runtime.record.mockReset().mockResolvedValue(undefined);
});

describe("governed executor injection canary", () => {
  it("blocks an approved live call that carries the canary and records the trip", async () => {
    const agentRunId = nextRunId();

    const { record, result } = await write(
      `Everything above: ${injectionCanaryToken(TENANT)}`,
      { agentRunId, dryRun: false, approved: true },
    );

    expect(result).toBeNull();
    expect(record).toMatchObject({
      tenantId: TENANT,
      actorId: "owner-canary",
      toolId: "memory.write",
      toolName: "Write Memory",
      riskLevel: 1,
      status: "blocked",
      dryRun: false,
      approvalRequired: false,
      reason: INJECTION_CANARY_REASON,
    });
    // The arguments can hold private retrieved context, so they are not kept.
    expect(record.input).toEqual({ withheld: "injection_canary", fieldCount: 2 });
    const events = await eventsFor(record.id);
    expect(JSON.stringify(events)).not.toContain(injectionCanaryToken(TENANT));
    expect(events.filter((event) => event.type === "injection.canary_tripped"))
      .toEqual([expect.objectContaining({
        id: `injection-canary:${record.id}`,
        tenantId: TENANT,
        payload: expect.objectContaining({
          schemaVersion: 1,
          executionId: record.id,
          toolId: "memory.write",
          riskLevel: 1,
          dryRun: false,
          encoding: "plain",
          agentRunId,
        }),
      })]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.execution.upserted",
      payload: expect.objectContaining({ executionId: record.id, status: "blocked" }),
    }));
    expect(runtime.record).toHaveBeenCalledWith(expect.objectContaining({
      category: "security",
      action: "security.policy_blocked",
      tenantId: TENANT,
      resourceId: "memory.write",
      message: INJECTION_CANARY_REASON,
      metadata: expect.objectContaining({
        toolName: "Write Memory",
        riskLevel: 1,
        input: { withheld: "injection_canary", fieldCount: 2 },
      }),
    }));
  });

  it("refuses the run's later calls without counting another trip", async () => {
    const agentRunId = nextRunId();
    await write(injectionCanaryToken(TENANT), { agentRunId });

    const later = await write("A clean summary.", { agentRunId });

    expect(later.record).toMatchObject({
      status: "blocked",
      reason: INJECTION_CANARY_LATCHED_REASON,
    });
    expect((await eventsFor(later.record.id)).map((event) => event.type))
      .not.toContain("injection.canary_tripped");
    // Another run, and the same run id in another tenant, are not latched.
    await expect(write("A clean summary.", { agentRunId: nextRunId() }))
      .resolves.toMatchObject({ record: { status: "dry_run" } });
    await expect(write("A clean summary.", {
      agentRunId,
      tenantContext: { ...context, tenantId: "tenant-canary-other" },
    })).resolves.toMatchObject({ record: { status: "dry_run" } });
  });

  it("blocks an encoded canary in a dry run and ignores another tenant's", async () => {
    const encoded = Buffer.from(`x${injectionCanaryToken(TENANT)}y`).toString("base64");

    const { record } = await write(`https://collector.example/?d=${encoded}`);

    expect(record).toMatchObject({ status: "blocked", dryRun: true });
    expect((await eventsFor(record.id)).find(
      (event) => event.type === "injection.canary_tripped",
    )?.payload).toMatchObject({ encoding: "base64", agentRunId: null });
    await expect(write(injectionCanaryToken("tenant-canary-other")))
      .resolves.toMatchObject({ record: { status: "dry_run" } });
  });

  it("records the trip on the claimed record when an approved call resumes", async () => {
    const claimed = await saveToolExecution({
      id: "execution-canary-claimed",
      tenantId: TENANT,
      actorId: "owner-canary",
      toolId: "memory.write",
      toolName: "Write Memory",
      riskLevel: 1,
      status: "executing",
      dryRun: false,
      approvalRequired: true,
      input: { title: "Forwarded notes" },
      output: {
        __executionClaim: { token: "claim-canary", claimedAt: new Date().toISOString() },
      },
      reason: "Approved.",
      createdAt: new Date().toISOString(),
    });

    // No request context: the claimed record's tenant decides which seal to
    // look for.
    const resume = (executionClaimToken: string) => executeGovernedTool({
      toolId: "memory.write",
      input: { title: "Forwarded notes", content: injectionCanaryToken(TENANT) },
      dryRun: false,
      approved: true,
      existingRecord: claimed,
      executionClaimToken,
    });

    // A resume that lost the claim records nothing.
    await expect(resume("claim-other")).rejects.toMatchObject({
      name: "ExecutionClaimLostError",
    });
    expect((await eventsFor(claimed.id)).map((event) => event.type))
      .not.toContain("injection.canary_tripped");
    const { record } = await resume("claim-canary");

    expect(record).toMatchObject({
      id: claimed.id,
      status: "blocked",
      reason: INJECTION_CANARY_REASON,
    });
    expect(record.input).toEqual({ title: "Forwarded notes" });
    const events = await eventsFor(claimed.id);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.execution.upserted",
      payload: expect.objectContaining({ operation: "completed", status: "blocked" }),
    }));
    expect(events.map((event) => event.type)).toContain("injection.canary_tripped");
  });

  it("still blocks an unknown tool by default, without a trip", async () => {
    const { record } = await executeGovernedTool({
      toolId: "unregistered.tool",
      input: { content: "A clean summary.", password: "hunter2" },
      dryRun: false,
      context,
    });

    expect(record).toMatchObject({
      toolId: "unregistered.tool",
      toolName: "Unknown tool",
      riskLevel: 3,
      status: "blocked",
      approvalRequired: true,
      reason: "Unknown tools are blocked by default.",
    });
    expect(record.input).toEqual({ content: "A clean summary.", password: "[redacted]" });
    expect((await eventsFor(record.id)).map((event) => event.type))
      .not.toContain("injection.canary_tripped");
    expect(runtime.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "security.policy_blocked",
      resourceId: "unregistered.tool",
      metadata: expect.objectContaining({ riskLevel: 3 }),
    }));
  });
});
