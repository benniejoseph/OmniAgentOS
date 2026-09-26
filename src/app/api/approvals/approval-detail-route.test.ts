import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
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
  reclaimStaleReadOnlyToolExecutionClaim: vi.fn(),
  resumeAgentRunInApprovalRequest: vi.fn(),
  wakeOperationJobByDedupeKey: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

vi.mock("@/lib/orchestration/resume-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestration/resume-queue")>()),
  resumeAgentRunInApprovalRequest: mocks.resumeAgentRunInApprovalRequest,
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
  reclaimStaleReadOnlyToolExecutionClaim:
    mocks.reclaimStaleReadOnlyToolExecutionClaim,
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
  mocks.after.mockReset();
  mocks.resumeAgentRunInApprovalRequest.mockReset().mockResolvedValue({
    status: "leased",
  });
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
  mocks.reclaimStaleReadOnlyToolExecutionClaim.mockReset();
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

  it("reclaims a stale approved read-only claim before resuming it", async () => {
    const executionScope = {
      version: 1 as const,
      tenantId: "tenant-a",
      initiatingActorId: "requester-a",
      executingPrincipalType: "agent" as const,
      executingPrincipalId: "agent:moltbook:g1",
      correlationId: "moltbook-home-read",
      purpose: "agent.tool.execute",
    };
    const executingRecord = {
      ...pendingRecord,
      toolId: "moltbook.home.read",
      toolName: "Read Moltbook Home",
      riskLevel: 0 as const,
      status: "executing" as const,
      approvalDecision: "approved" as const,
      approvedBy: "requester-a",
      approvedAt: "2026-09-21T13:00:18.681Z",
      output: {
        __sealedInput: { schemaVersion: 1 },
        __approvalFingerprint: "fingerprint",
        __executionClaim: {
          token: "stale-read-token",
          claimedAt: "2026-09-21T13:00:18.681Z",
        },
      },
    };
    const registeredTool = {
      id: executingRecord.toolId,
      name: executingRecord.toolName,
      description: "Read the linked agent's bounded Moltbook home summary.",
      category: "connector" as const,
      status: "active" as const,
      riskLevel: 0 as const,
      dryRunSupported: true,
      approvalRequired: false,
      operationClass: "read_only" as const,
      reversible: true,
      inputSchema: { type: "object", additionalProperties: false },
    };
    const reclaimedRecord = {
      ...executingRecord,
      output: {
        ...executingRecord.output,
        __executionClaim: {
          token: "reclaimed-read-token",
          claimedAt: "2026-09-21T13:08:18.681Z",
        },
      },
    };
    mocks.getToolExecution.mockResolvedValue(executingRecord);
    mocks.getGovernedTool.mockReturnValue(registeredTool);
    mocks.getToolExecutionScopeBinding.mockResolvedValue({
      executionScope,
      requesterRole: "operator",
      toolId: executingRecord.toolId,
      inputSha256: "b".repeat(64),
    });
    mocks.reclaimStaleReadOnlyToolExecutionClaim.mockResolvedValue(
      reclaimedRecord,
    );
    mocks.openToolExecutionInput.mockReturnValue({});
    mocks.executeGovernedTool.mockResolvedValue({
      record: {
        ...reclaimedRecord,
        status: "executed",
        output: { source: "moltbook", untrusted: true, data: {} },
      },
      result: { source: "moltbook", untrusted: true, data: {} },
    });

    const response = await POST(new Request(
      `http://asael.test/api/approvals/${executingRecord.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "approval-retry-moltbook-home-read",
        },
        body: JSON.stringify({ kind: "tool", decision: "approve" }),
      },
    ), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.approveAndClaimToolExecution).not.toHaveBeenCalled();
    expect(mocks.reclaimStaleReadOnlyToolExecutionClaim).toHaveBeenCalledWith(
      executingRecord,
      expect.objectContaining({
        tenantId: "tenant-a",
        executionScope,
        idempotencyKey: "approval-retry-moltbook-home-read",
        claimToken: expect.any(String),
        tool: registeredTool,
      }),
    );
    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "moltbook.home.read",
        input: {},
        existingRecord: reclaimedRecord,
        executionClaimToken: expect.any(String),
        agentRunId: undefined,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      record: { status: "executed", approvalRequired: true },
      continuation: { scheduled: true },
    });
  });
});

describe("This Mac approval continuation", () => {
  const observation = {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: pendingRecord.id,
    operation: "screenshot",
    snapshotRevision: "rev-1",
  };

  function approveThisMacAction() {
    mocks.approveAndClaimToolExecution.mockImplementation(async () => ({
      outcome: "claimed",
      record: {
        ...pendingRecord,
        status: "executing",
        approvalDecision: "approved",
        approvedBy: "requester-a",
      },
    }));
    mocks.openToolExecutionInput.mockReturnValue(pendingRecord.input);
    mocks.findAgentRunWaitingForToolApproval.mockResolvedValue({
      id: "run-this-mac",
      status: "waiting_approval",
      continuation: {
        context: {
          tenantId: "tenant-a",
          actorId: "requester-a",
          role: "operator",
        },
      },
    });
    const result = {
      record: { ...pendingRecord, status: "executed" },
      result: { ok: true },
      computerObservation: observation,
    };
    mocks.executeGovernedTool.mockResolvedValue(result);
    return result;
  }

  async function postApproval() {
    return POST(new Request(
      `http://asael.test/api/approvals/${pendingRecord.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "approval-this-mac",
        },
        body: JSON.stringify({ kind: "tool", decision: "approve" }),
      },
    ), routeContext());
  }

  it("resumes with the observation under the resume job's lease after responding", async () => {
    const result = approveThisMacAction();

    const response = await postApproval();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      continuation: { scheduled: true, resumeJobs: 0 },
    });
    expect(mocks.resumeAgentRunInApprovalRequest).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);

    await mocks.after.mock.calls[0][0]();

    expect(mocks.resumeAgentRunInApprovalRequest).toHaveBeenCalledWith({
      executionId: pendingRecord.id,
      toolExecution: result,
      tenantId: "tenant-a",
    });
    expect(mocks.wakeOperationJobByDedupeKey).not.toHaveBeenCalled();
  });

  it("hands the run to the durable queue when the in-request resume throws", async () => {
    approveThisMacAction();
    mocks.resumeAgentRunInApprovalRequest.mockRejectedValue(
      new Error("resume failed"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await postApproval();
      expect(response.status).toBe(200);
      await mocks.after.mock.calls[0][0]();
    } finally {
      warn.mockRestore();
    }

    expect(mocks.wakeOperationJobByDedupeKey).toHaveBeenCalledTimes(1);
    expect(mocks.wakeOperationJobByDedupeKey).toHaveBeenCalledWith(
      `agent-resume:${pendingRecord.id}`,
      { tenantId: "tenant-a" },
    );
  });

  it("wakes the resume job at once when the action returned no observation", async () => {
    const result = approveThisMacAction();
    mocks.executeGovernedTool.mockResolvedValue({
      ...result,
      computerObservation: undefined,
    });
    mocks.wakeOperationJobByDedupeKey.mockResolvedValue([{ id: "job-1" }]);

    const response = await postApproval();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      continuation: { scheduled: true, resumeJobs: 1 },
    });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.resumeAgentRunInApprovalRequest).not.toHaveBeenCalled();
    expect(mocks.wakeOperationJobByDedupeKey).toHaveBeenCalledWith(
      `agent-resume:${pendingRecord.id}`,
      { tenantId: "tenant-a" },
    );
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
