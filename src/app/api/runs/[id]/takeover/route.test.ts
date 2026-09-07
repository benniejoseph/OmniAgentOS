import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(),
  getActiveBrowserTakeover: vi.fn(),
  recordBrowserTakeoverAction: vi.fn(),
  releaseBrowserTakeover: vi.fn(),
  resolveBrowserProfileSession: vi.fn(),
  startBrowserTakeover: vi.fn(),
  callMcpTool: vi.fn(),
  captureBrowserFrameAfterToolSafely: vi.fn(),
  getMcpConnector: vi.fn(),
  getMcpToolById: vi.fn(),
  findAgentRunWaitingForToolApproval: vi.fn(),
  getAgentRun: vi.fn(),
  approveAndClaimToolExecution: vi.fn(),
  completeClaimedToolExecution: vi.fn(),
  getToolExecution: vi.fn(),
  wakeOperationJobByDedupeKey: vi.fn(),
  toolApprovalMutationFromRequest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: mocks.forbiddenResponse,
}));
vi.mock("@/lib/browser/profiles", () => ({
  getActiveBrowserTakeover: mocks.getActiveBrowserTakeover,
  recordBrowserTakeoverAction: mocks.recordBrowserTakeoverAction,
  releaseBrowserTakeover: mocks.releaseBrowserTakeover,
  resolveBrowserProfileSession: mocks.resolveBrowserProfileSession,
  startBrowserTakeover: mocks.startBrowserTakeover,
}));
vi.mock("@/lib/browser/frames", () => ({
  captureBrowserFrameAfterToolSafely: mocks.captureBrowserFrameAfterToolSafely,
}));
vi.mock("@/lib/connectors/mcp-client", () => ({ callMcpTool: mocks.callMcpTool }));
vi.mock("@/lib/connectors/mcp-trust", () => ({
  isAsaelPlaywrightMcpEndpoint: vi.fn(() => true),
}));
vi.mock("@/lib/connectors/store", () => ({
  createMcpToolId: vi.fn((connectorId: string, name: string) => `${connectorId}:${name}`),
  getMcpConnector: mocks.getMcpConnector,
  getMcpToolById: mocks.getMcpToolById,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  getAgentResumeJobDedupeKey: vi.fn((id: string) => `resume:${id}`),
  wakeOperationJobByDedupeKey: mocks.wakeOperationJobByDedupeKey,
}));
vi.mock("@/lib/runs/store", () => ({
  findAgentRunWaitingForToolApproval: mocks.findAgentRunWaitingForToolApproval,
  getAgentRun: mocks.getAgentRun,
}));
vi.mock("@/lib/tools/audit-store", () => ({
  approveAndClaimToolExecution: mocks.approveAndClaimToolExecution,
  completeClaimedToolExecution: mocks.completeClaimedToolExecution,
  getToolExecution: mocks.getToolExecution,
}));
vi.mock("@/lib/tools/approval-events", () => ({
  toolApprovalMutationFromRequest: mocks.toolApprovalMutationFromRequest,
}));

import { POST } from "@/app/api/runs/[id]/takeover/route";

const auth = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "operator" as const,
  source: "session" as const,
};
const executionScope = {
  version: 1 as const,
  tenantId: auth.tenantId,
  initiatingActorId: auth.actorId,
  executingPrincipalType: "user" as const,
  executingPrincipalId: auth.actorId,
  workspaceId: null,
  projectId: null,
  missionId: null,
  delegationId: null,
  correlationId: "request-a",
  causationId: "execution-a",
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "browser.takeover.test",
};
const run = {
  id: "run-a",
  ownerActorId: auth.actorId,
  status: "waiting_approval",
  continuation: {
    pendingToolCall: { executionId: "execution-a" },
    executionScope,
  },
};
const execution = {
  id: "execution-a",
  tenantId: auth.tenantId,
  actorId: auth.actorId,
  toolId: "playwright:browser_type",
  toolName: "Type",
  riskLevel: 2,
  dryRun: false,
  approvalRequired: true,
  status: "approval_required",
  input: {},
  reason: "Approval required.",
  createdAt: new Date().toISOString(),
};
const mcpTool = {
  id: execution.toolId,
  connectorId: "playwright",
  name: "browser_type",
  status: "active",
};
const connector = {
  id: "playwright",
  tenantId: auth.tenantId,
  endpoint: "https://omniagent-os-browser.fly.dev/mcp",
  status: "active",
};
const takeover = {
  id: "browser_takeover:00000000-0000-4000-8000-000000000001",
  tenantId: auth.tenantId,
  ownerActorId: auth.actorId,
  runId: run.id,
  executionId: execution.id,
  profileId: "browser_profile:00000000-0000-4000-8000-000000000001",
  state: "active",
  actionCount: 0,
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  lastActionAt: null,
  releasedAt: null,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorizeRequest.mockResolvedValue(auth);
  mocks.getAgentRun.mockResolvedValue(run);
  mocks.findAgentRunWaitingForToolApproval.mockResolvedValue(run);
  mocks.getToolExecution.mockResolvedValue(execution);
  mocks.getMcpToolById.mockResolvedValue(mcpTool);
  mocks.getMcpConnector.mockResolvedValue(connector);
  mocks.resolveBrowserProfileSession.mockResolvedValue({
    id: takeover.profileId,
    revision: 1,
    allowedDomains: ["example.com"],
  });
  mocks.getActiveBrowserTakeover.mockResolvedValue(takeover);
  mocks.startBrowserTakeover.mockResolvedValue(takeover);
  mocks.recordBrowserTakeoverAction.mockResolvedValue({ ...takeover, actionCount: 1 });
  mocks.releaseBrowserTakeover.mockResolvedValue({
    ...takeover,
    state: "released",
    releasedAt: new Date().toISOString(),
  });
  mocks.toolApprovalMutationFromRequest.mockReturnValue({
    executionScope,
    idempotencyKey: "takeover-handback",
  });
  mocks.wakeOperationJobByDedupeKey.mockResolvedValue([{ id: "job-a" }]);
  mocks.captureBrowserFrameAfterToolSafely.mockResolvedValue(undefined);
});

describe("browser takeover route", () => {
  it("authenticates before disclosing takeover action validation", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("Authentication required."));
    mocks.forbiddenResponse.mockReturnValue(Response.json(
      { error: "Authentication required." },
      { status: 401 },
    ));

    const response = await post({ action: "not-a-real-action" });

    expect(response.status).toBe(401);
    expect(mocks.authorizeRequest).toHaveBeenCalledOnce();
    expect(mocks.getAgentRun).not.toHaveBeenCalled();
  });

  it("requires the actor-owned run to be paused on a managed browser action", async () => {
    mocks.getAgentRun.mockResolvedValue({ ...run, status: "running" });

    const response = await post({ action: "start" });

    expect(response.status).toBe(409);
    expect(mocks.startBrowserTakeover).not.toHaveBeenCalled();
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });

  it("starts a lease bound to the exact pending execution and profile", async () => {
    const response = await post({ action: "start" });

    expect(response.status).toBe(201);
    expect(mocks.startBrowserTakeover).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: auth.tenantId,
      ownerActorId: auth.actorId,
      runId: run.id,
      executionId: execution.id,
      profileId: takeover.profileId,
    }));
  });

  it("sends private text directly without writing it to takeover events", async () => {
    mocks.callMcpTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const response = await post({
      action: "type",
      target: "e12",
      text: "super-secret-value",
      submit: true,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.observation).toBeUndefined();
    expect(mocks.callMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "browser_type",
      args: expect.objectContaining({ text: "super-secret-value", target: "e12" }),
    }));
    expect(mocks.recordBrowserTakeoverAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "type",
      target: "e12",
    }));
    expect(JSON.stringify(mocks.recordBrowserTakeoverAction.mock.calls)).not.toContain(
      "super-secret-value",
    );
  });

  it("records human completion, captures fresh evidence, releases, and wakes resume", async () => {
    const claimed = {
      ...execution,
      status: "executing",
      approvalDecision: "approved",
      approvedAt: new Date().toISOString(),
      approvedBy: auth.actorId,
    };
    mocks.approveAndClaimToolExecution.mockResolvedValue({ outcome: "claimed", record: claimed });
    mocks.completeClaimedToolExecution.mockImplementation(async (record) => record);

    const response = await post({ action: "handback" });

    expect(response.status).toBe(200);
    expect(mocks.completeClaimedToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "executed",
        output: expect.objectContaining({ status: "completed_by_user_takeover" }),
      }),
      expect.any(String),
      expect.objectContaining({ idempotencyKey: "takeover-handback" }),
    );
    expect(mocks.captureBrowserFrameAfterToolSafely).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: execution.id }),
    );
    expect(mocks.releaseBrowserTakeover).toHaveBeenCalled();
    expect(mocks.wakeOperationJobByDedupeKey).toHaveBeenCalledWith(
      `resume:${execution.id}`,
      { tenantId: auth.tenantId },
    );
  });
});

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/runs/${run.id}/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: run.id }) },
  );
}
