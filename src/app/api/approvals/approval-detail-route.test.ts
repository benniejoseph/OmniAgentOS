import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  approveAndClaimToolExecution: vi.fn(),
  executeGovernedTool: vi.fn(),
  findAgentRunWaitingForToolApproval: vi.fn(),
  getToolExecutionEffectIntentV2: vi.fn(),
  getToolExecution: vi.fn(),
  getToolExecutionScopeBinding: vi.fn(),
  getGovernedTool: vi.fn(),
  getMcpGovernedTool: vi.fn(),
  getOpenApiGovernedTool: vi.fn(),
  openToolExecutionInput: vi.fn(),
  publicToolExecution: vi.fn(),
  reclaimStaleGoogleWorkspaceCreateToolExecutionClaim: vi.fn(),
  wakeOperationJobByDedupeKey: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/tools/audit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/audit-store")>()),
  approveAndClaimToolExecution: mocks.approveAndClaimToolExecution,
  getToolExecutionEffectIntentV2: mocks.getToolExecutionEffectIntentV2,
  getToolExecution: mocks.getToolExecution,
  openToolExecutionInput: mocks.openToolExecutionInput,
  publicToolExecution: mocks.publicToolExecution,
  reclaimStaleGoogleWorkspaceCreateToolExecutionClaim:
    mocks.reclaimStaleGoogleWorkspaceCreateToolExecutionClaim,
}));

vi.mock("@/lib/tools/execution-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/execution-scope")>()),
  getToolExecutionScopeBinding: mocks.getToolExecutionScopeBinding,
}));

vi.mock("@/lib/tools/executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/executor")>()),
  executeGovernedTool: mocks.executeGovernedTool,
}));

vi.mock("@/lib/runs/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/store")>()),
  findAgentRunWaitingForToolApproval:
    mocks.findAgentRunWaitingForToolApproval,
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/job-queue")>()),
  getAgentResumeJobDedupeKey: (executionId: string) =>
    `agent-resume:${executionId}`,
  wakeOperationJobByDedupeKey: mocks.wakeOperationJobByDedupeKey,
}));

vi.mock("@/lib/tools/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/registry")>()),
  getGovernedTool: mocks.getGovernedTool,
}));

vi.mock("@/lib/connectors/governed-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/governed-tools")>()),
  getMcpGovernedTool: mocks.getMcpGovernedTool,
  getOpenApiGovernedTool: mocks.getOpenApiGovernedTool,
}));

import { GET, POST } from "@/app/api/approvals/[id]/route";

const pendingRecord = {
  id: "execution-voice",
  tenantId: "tenant-a",
  actorId: "requester-a",
  toolId: "calendar.event.create",
  toolName: "Create event",
  riskLevel: 1 as const,
  status: "approval_required" as const,
  dryRun: false,
  approvalRequired: true,
  input: { calendarId: "primary", title: "Reviewed meeting" },
  reason: "Voice-originated actions require visible approval.",
  createdAt: "2026-09-07T12:00:00.000Z",
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "requester-a",
    role: "operator",
    source: "session",
  });
  mocks.getToolExecution.mockReset().mockResolvedValue(pendingRecord);
  mocks.getToolExecutionEffectIntentV2.mockReset().mockReturnValue(undefined);
  mocks.approveAndClaimToolExecution.mockReset();
  mocks.openToolExecutionInput.mockReset();
  mocks.reclaimStaleGoogleWorkspaceCreateToolExecutionClaim.mockReset();
  mocks.getToolExecutionScopeBinding.mockReset();
  mocks.executeGovernedTool.mockReset();
  mocks.findAgentRunWaitingForToolApproval.mockReset().mockResolvedValue(undefined);
  mocks.wakeOperationJobByDedupeKey.mockReset().mockResolvedValue([]);
  mocks.getGovernedTool.mockReset().mockReturnValue({
    id: pendingRecord.toolId,
    name: "Create calendar event",
    description: "Creates an event on the selected calendar.",
    riskLevel: 1,
    reversible: true,
  });
  mocks.getMcpGovernedTool.mockReset().mockResolvedValue(undefined);
  mocks.getOpenApiGovernedTool.mockReset().mockResolvedValue(undefined);
  mocks.publicToolExecution.mockReset().mockImplementation((record) => record);
});

describe("tool approval detail route", () => {
  it("returns exact visible action evidence for a durable decision", async () => {
    const response = await GET(request(), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      approval: {
        id: pendingRecord.id,
        status: "approval_required",
        toolId: pendingRecord.toolId,
        title: "Create calendar event",
        description: "Creates an event on the selected calendar.",
        riskLevel: 1,
        reversible: true,
        reason: pendingRecord.reason,
        input: pendingRecord.input,
        requestedBy: "requester-a",
        approvalProgress: { approvals: 0, required: 1 },
        canApprove: true,
        blockReason: null,
        canReject: true,
      },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "execute.tool",
        resourceId: pendingRecord.id,
      }),
    );
  });

  it("blocks requester self-approval for a risk-3 action", async () => {
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-a",
      actorId: "requester-a",
      role: "admin",
      source: "session",
    });
    mocks.getToolExecution.mockResolvedValue({
      ...pendingRecord,
      riskLevel: 3,
    });

    const response = await GET(request(), routeContext());
    const body = await response.json();

    expect(body.approval).toMatchObject({
      riskLevel: 3,
      canApprove: false,
      canReject: true,
      approvalProgress: { approvals: 0, required: 2 },
      blockReason: expect.stringMatching(/cannot approve their own/i),
    });
  });

  it("reclaims a stale approved native create before resuming its exact execution", async () => {
    const executionScope = {
      version: 1 as const,
      tenantId: "tenant-a",
      initiatingActorId: "requester-a",
      executingPrincipalType: "user" as const,
      executingPrincipalId: "requester-a",
      correlationId: "original-create",
      purpose: "tool.google.docs.create",
    };
    const executingRecord = {
      ...pendingRecord,
      toolId: "google.docs.create",
      toolName: "Create Google Document",
      riskLevel: 2 as const,
      status: "executing" as const,
      approvalDecision: "approved" as const,
      approvedBy: "requester-a",
      approvedAt: "2026-09-19T06:00:00.000Z",
      output: {
        __executionClaim: {
          token: "expired-token",
          claimedAt: "2026-09-19T06:00:00.000Z",
        },
        __effectIntentV2: { schemaVersion: 2 },
      },
    };
    const toolInput = {
      title: "Recovered note",
      bodyText: "Resume only this exact approved create.",
    };
    mocks.getToolExecution.mockResolvedValue(executingRecord);
    mocks.getToolExecutionEffectIntentV2.mockReturnValue({ schemaVersion: 2 });
    mocks.getToolExecutionScopeBinding.mockResolvedValue({
      executionScope,
      requesterRole: "operator",
      toolId: executingRecord.toolId,
      inputSha256: "a".repeat(64),
    });
    mocks.reclaimStaleGoogleWorkspaceCreateToolExecutionClaim
      .mockImplementation(async (record, options) => ({
        ...record,
        output: {
          ...record.output,
          __executionClaim: {
            token: options.claimToken,
            claimedAt: "2026-09-19T06:06:00.000Z",
          },
        },
      }));
    mocks.openToolExecutionInput.mockReturnValue(toolInput);
    mocks.executeGovernedTool.mockImplementation(async (options) => ({
      record: {
        ...options.existingRecord,
        status: "executed",
        output: {
          toolId: "google.docs.create",
          resourceId: "document_recovered",
        },
      },
      result: {
        toolId: "google.docs.create",
        resourceId: "document_recovered",
      },
    }));

    const response = await POST(new Request(
      `http://asael.test/api/approvals/${executingRecord.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "approval-retry-docs-create",
        },
        body: JSON.stringify({
          kind: "tool",
          decision: "approve",
          reason: "Resume the previously approved create.",
        }),
      },
    ), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.approveAndClaimToolExecution).not.toHaveBeenCalled();
    expect(
      mocks.reclaimStaleGoogleWorkspaceCreateToolExecutionClaim,
    ).toHaveBeenCalledWith(
      executingRecord,
      expect.objectContaining({
        tenantId: "tenant-a",
        executionScope,
        idempotencyKey: "approval-retry-docs-create",
        claimToken: expect.any(String),
      }),
    );
    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "google.docs.create",
      input: toolInput,
      existingRecord: expect.objectContaining({ status: "executing" }),
      executionClaimToken: expect.any(String),
    }));
    await expect(response.json()).resolves.toMatchObject({
      record: { status: "executed" },
      result: { resourceId: "document_recovered" },
      continuation: { scheduled: true },
    });
  });
});

function request() {
  return new Request(
    `http://asael.test/api/approvals/${pendingRecord.id}`,
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: pendingRecord.id }) };
}
