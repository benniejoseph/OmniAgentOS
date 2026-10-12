import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import type { SecurityContext } from "@/lib/security/types";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  recordRuntimeEvent: vi.fn(),
  readPublicWebSource: vi.fn(),
  toolOverrides: new Map<string, ToolDefinition>(),
}));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  recordRuntimeEventSafely: mocks.recordRuntimeEvent,
}));

vi.mock("@/lib/tools/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/registry")>();
  return {
    ...actual,
    getGovernedTool: (toolId: string) =>
      mocks.toolOverrides.get(toolId) || actual.getGovernedTool(toolId),
  };
});

vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/web-search/read", () => ({ readPublicWebSource: mocks.readPublicWebSource }));

import { executeGovernedTool } from "@/lib/tools/executor";

const context: SecurityContext = {
  tenantId: "tenant-read-only-executor",
  actorId: "owner-read-only-executor",
  role: "admin",
  source: "session",
};

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-read-only-executor-"),
  );
  delete process.env.DATABASE_URL;
  mocks.recordRuntimeEvent.mockReset().mockResolvedValue(undefined);
  mocks.toolOverrides.clear();
  mocks.readPublicWebSource.mockReset().mockResolvedValue({
    title: "Public report", url: "https://example.com/report", content: "Bounded source text.",
    contentType: "text/html", fetchedAt: "2026-10-07T00:00:00.000Z", citationId: "web-fixture",
    truncated: false, contentTrust: "untrusted",
  });
});

describe("governed executor read-only constraint", () => {
  it("runs public source reading with scoped audit and cancellation through the governed executor", async () => {
    const controller = new AbortController();
    const { record, result } = await executeGovernedTool({
      toolId: "web.read", input: { url: "https://example.com/report" }, context,
      requireReadOnly: true, dryRun: false, abortSignal: controller.signal,
    });
    expect(record).toMatchObject({ tenantId: context.tenantId, actorId: context.actorId, toolId: "web.read", status: "executed", riskLevel: 0 });
    expect(result).toMatchObject({ contentTrust: "untrusted", title: "Public report" });
    expect(mocks.readPublicWebSource).toHaveBeenCalledWith({ url: "https://example.com/report", abortSignal: expect.any(AbortSignal) });
    expect(await listStreamEvents(`tool_execution:${record.id}`, { tenantId: context.tenantId })).toContainEqual(expect.objectContaining({
      type: "tool.execution.upserted", payload: expect.objectContaining({ executionId: record.id, status: "executed" }),
    }));
  });

  it("rejects authentication or arbitrary request options before public reading", async () => {
    await expect(executeGovernedTool({
      toolId: "web.read", input: { url: "https://example.com/report", headers: { authorization: "unsafe" } }, context,
      requireReadOnly: true,
    })).rejects.toThrow();
    expect(mocks.readPublicWebSource).not.toHaveBeenCalled();
  });

  it("blocks a low-risk write even with approval and records the normal policy audit", async () => {
    const { record, result } = await executeGovernedTool({
      toolId: "memory.write",
      input: { title: "Fixture note", content: "A harmless test note." },
      context,
      dryRun: true,
      approved: true,
      requireReadOnly: true,
    });

    expect(result).toBeNull();
    expect(record).toMatchObject({
      tenantId: context.tenantId,
      actorId: context.actorId,
      toolId: "memory.write",
      riskLevel: 1,
      status: "blocked",
      reason: "This run permits only read-only tools.",
    });
    expect(await listStreamEvents(`tool_execution:${record.id}`, {
      tenantId: context.tenantId,
    })).toContainEqual(expect.objectContaining({
      type: "tool.execution.upserted",
      payload: expect.objectContaining({ executionId: record.id, status: "blocked" }),
    }));
    expect(mocks.recordRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "security.policy_blocked",
      tenantId: context.tenantId,
      resourceId: "memory.write",
      message: "This run permits only read-only tools.",
    }));
  });

  it("also checks the resolved operation class for a risk-zero fixture", async () => {
    const tool: ToolDefinition = {
      id: "fixture.operation",
      name: "Fixture Operation",
      description: "A fixed metadata fixture with no implementation.",
      category: "app",
      status: "active",
      riskLevel: 0,
      operationClass: "mutation",
      dryRunSupported: true,
      approvalRequired: false,
      inputSchema: { type: "object", properties: {} },
    };
    mocks.toolOverrides.set(tool.id, tool);

    await expect(executeGovernedTool({
      toolId: tool.id,
      input: {},
      context,
      dryRun: true,
      requireReadOnly: true,
    })).resolves.toMatchObject({
      record: { status: "blocked", reason: "This run permits only read-only tools." },
      result: null,
    });
  });

  it("permits a read-only tool to reach its ordinary dry-run policy", async () => {
    await expect(executeGovernedTool({
      toolId: "runs.list",
      input: { limit: 1 },
      context,
      dryRun: true,
      requireReadOnly: true,
    })).resolves.toMatchObject({ record: { status: "dry_run", riskLevel: 0 } });
  });

  it("keeps ordinary low-risk dry runs unchanged without the constraint", async () => {
    await expect(executeGovernedTool({
      toolId: "memory.write",
      input: { title: "Fixture note", content: "A harmless test note." },
      context,
      dryRun: true,
    })).resolves.toMatchObject({ record: { status: "dry_run", riskLevel: 1 } });
  });
});
