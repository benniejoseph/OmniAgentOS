import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getToolExecution: vi.fn(),
  getGovernedTool: vi.fn(),
  getMcpGovernedTool: vi.fn(),
  getOpenApiGovernedTool: vi.fn(),
  publicToolExecution: vi.fn(),
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
  getToolExecution: mocks.getToolExecution,
  publicToolExecution: mocks.publicToolExecution,
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

import { GET } from "@/app/api/approvals/[id]/route";

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
});

function request() {
  return new Request(
    `http://asael.test/api/approvals/${pendingRecord.id}`,
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: pendingRecord.id }) };
}
