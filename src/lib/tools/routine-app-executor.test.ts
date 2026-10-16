import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const mocks = vi.hoisted(() => ({ executeApp: vi.fn() }));

vi.mock("@/lib/app-services/tool-dispatcher", () => ({
  executeFirstPartyAppTool: mocks.executeApp,
}));
vi.mock("@/lib/trust/ledger", () => ({
  actionClassFor: (toolId: string) => toolId,
  recordActionOutcome: vi.fn(),
  resolveAutonomy: vi.fn(),
}));
vi.mock("@/lib/security/network", () => ({
  assertPublicHttpUrl: async (value: string) => new URL(value).toString(),
  fetchPublicHttpUrl: vi.fn(),
}));
vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

import { listToolExecutions } from "@/lib/tools/audit-store";
import { executeGovernedTool } from "@/lib/tools/executor";

// Load the real service graph during collection, not inside a timed mutation
// test: module compilation is substantial on a memory-constrained desktop.
const actualAppDispatcher = await vi.importActual<typeof import("@/lib/app-services/tool-dispatcher")>(
  "@/lib/app-services/tool-dispatcher",
);

const context: SecurityContext = {
  tenantId: "tenant-routine-app",
  actorId: "owner-routine-app",
  role: "admin",
  source: "default",
};
const executionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "user",
  executingPrincipalId: context.actorId,
  correlationId: "routine-app-request",
  purpose: "tool.routine_app.test",
});
const routineActions: { toolId: string; input: Record<string, unknown> }[] = [
  {
    toolId: "app.csm.clients.update",
    input: {
      projectId: "project-client", expectedRevision: "revision-1",
      profile: { customerGoals: "Prepare the agreed launch checklist." },
    },
  },
  {
    toolId: "app.csm.clients.sources.link",
    input: {
      projectId: "project-client", expectedRevision: "revision-1",
      libraryItemId: "library-launch-brief", versionId: "version-2",
      contentSha256: "a".repeat(64),
    },
  },
  {
    toolId: "app.csm.clients.sources.unlink",
    input: {
      projectId: "project-client", expectedRevision: "revision-1",
      libraryItemId: "library-launch-brief",
    },
  },
  {
    toolId: "app.workspace_templates.instantiate",
    input: {
      templateId: "workspace-template:11111111-1111-4111-8111-111111111111",
      templateVersionId: "template-version-2",
    },
  },
];

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-routine-app-"));
  delete process.env.DATABASE_URL;
  mocks.executeApp.mockReset().mockResolvedValue({
    handled: true, result: { data: { saved: true } },
  });
});

describe("routine app actions through the governed executor", () => {
  it.each(routineActions)("executes $toolId once without approval and preserves its exact scope and input", async (action) => {
    const request = {
      ...action, context, executionScope, dryRun: false,
      idempotencyKey: `routine:${action.toolId}`,
    };
    const first = await executeGovernedTool(request);
    const replay = await executeGovernedTool(request);

    expect(first).toMatchObject({
      record: {
        status: "executed", riskLevel: 1, approvalRequired: false,
        tenantId: context.tenantId, actorId: context.actorId, toolId: action.toolId,
      },
      result: { data: { saved: true } },
    });
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.record.status).toBe("executed");
    expect(mocks.executeApp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      toolId: action.toolId, toolInput: action.input,
      // App effects use the tenant-bound durable execution identity.
      context, executionScope, idempotencyKey: first.record.id,
    }));
    expect((await listToolExecutions(20, { tenantId: context.tenantId }))
      .filter((record) => record.status === "approval_required")).toEqual([]);
  });

  it.each(routineActions)("honors an explicit hold on $toolId even though the ordinary policy is automatic", async (action) => {
    const request = {
      ...action, context, executionScope, dryRun: false,
      idempotencyKey: `held:${action.toolId}`, forceApproval: true,
    };
    const pending = await executeGovernedTool(request);
    const replay = await executeGovernedTool(request);

    expect(pending.record).toMatchObject({ status: "approval_required", approvalRequired: true });
    expect(replay.record.id).toBe(pending.record.id);
    expect(mocks.executeApp).not.toHaveBeenCalled();
    expect((await listToolExecutions(20, { tenantId: context.tenantId }))
      .filter((record) => record.status === "approval_required")
      .map((record) => record.id)).toEqual([pending.record.id]);

    // An already displayed exact review stays pending even if a continuation
    // omits the hold: a new routine classification cannot approve it silently.
    const resumed = await executeGovernedTool({
      ...request, forceApproval: false, existingRecord: pending.record,
    });
    expect(resumed.record).toMatchObject({
      id: pending.record.id, status: "approval_required", approvalRequired: true,
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it.each(routineActions)("does not give a read-only run write authority for $toolId", async (action) => {
    const outcome = await executeGovernedTool({
      ...action, context, executionScope, dryRun: false, approved: true,
      requireReadOnly: true, idempotencyKey: `read-only:${action.toolId}`,
    });
    expect(outcome).toMatchObject({
      record: { status: "blocked", reason: "This run permits only read-only tools." },
      result: null,
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it.each(routineActions)("retains the real application permission check for $toolId", async (action) => {
    // Exercise the production dispatcher and service authorization for a viewer.
    // The normal success tests above substitute only the eventual app effect.
    mocks.executeApp.mockImplementation(actualAppDispatcher.executeFirstPartyAppTool);

    const outcome = await executeGovernedTool({
      ...action, context: { ...context, role: "viewer" }, executionScope,
      dryRun: false, idempotencyKey: `viewer:${action.toolId}`,
    });
    expect(outcome).toMatchObject({ record: { status: "failed" }, result: null });
    expect(outcome.record.reason).toMatch(/Role viewer cannot perform (write\.memory|run\.agent)/);
  });

  it.each(["tenant", "actor"])("rejects a different %s execution scope before app dispatch", async (boundary) => {
    const foreignScope = createExecutionScope({
      ...executionScope,
      ...(boundary === "tenant"
        ? { tenantId: "tenant-other" }
        : { initiatingActorId: "actor-other" }),
    });
    await expect(executeGovernedTool({
      ...routineActions[0], context, executionScope: foreignScope,
      dryRun: false, idempotencyKey: `foreign:${boundary}`,
    })).rejects.toThrow(`does not match the authorized ${boundary}`);
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it.each([
    {
      toolId: "app.memory.shared.write",
      input: { scope: "project", projectId: "project-client", title: "Plan", content: "Client plan" },
    },
    {
      toolId: "app.workspace_templates.publish",
      input: { name: "Client launch", project: { title: "Launch", objective: "Prepare launch", tasks: [] } },
    },
  ])("still requires review before $toolId can dispatch", async (action) => {
    const outcome = await executeGovernedTool({
      ...action, context, executionScope, dryRun: false,
      idempotencyKey: `critical:${action.toolId}`,
    });
    expect(outcome).toMatchObject({
      record: { status: "approval_required", approvalRequired: true }, result: null,
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });
});
