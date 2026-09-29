import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityPolicyError } from "@/lib/security/context";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
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

import { GET } from "@/app/api/inbox/route";

const tenantId = "tenant-inbox-route";

function signedIn(role: "viewer" | "operator" | "admin") {
  mocks.authorizeRequest.mockResolvedValue({
    tenantId,
    actorId: `${role}-actor`,
    role,
    source: "session",
  });
}

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-inbox-route-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_ACCESS_REQUEST_FILE;
  mocks.authorizeRequest.mockReset();
});

describe("GET /api/inbox", () => {
  it("counts what the caller may decide, as a private read", async () => {
    await savePendingToolApproval("inbox-route-tool-a");
    await savePendingToolApproval("inbox-route-tool-b");
    await savePendingAccessRequest("inbox-route-access");

    signedIn("operator");
    const operator = await GET(request());
    expect(operator.status).toBe(200);
    expect(operator.headers.get("cache-control")).toBe("private, no-store");
    await expect(operator.json()).resolves.toEqual({ pending: 2, approvals: 2 });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "inbox",
    }));

    signedIn("admin");
    await expect((await GET(request())).json()).resolves.toEqual({
      pending: 3,
      approvals: 2,
      accessRequests: 1,
    });

    signedIn("viewer");
    const viewer = await GET(request());
    expect(viewer.headers.get("cache-control")).toBe("private, no-store");
    await expect(viewer.json()).resolves.toEqual({ pending: 0 });
  });

  it("answers a caller without a session before counting anything", async () => {
    mocks.authorizeRequest.mockRejectedValue(
      new SecurityPolicyError("Authentication required.", 401),
    );

    const response = await GET(request());

    expect(response.status).toBe(401);
  });
});

function request() {
  return new Request("https://asael.test/api/inbox");
}

async function savePendingToolApproval(id: string) {
  const store = await import("@/lib/tools/audit-store");
  await store.saveToolExecution({
    id,
    tenantId,
    actorId: "queue-owner",
    toolId: "http.request",
    toolName: "HTTP Request",
    riskLevel: 2,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: "https://status.example.com" },
    createdAt: new Date().toISOString(),
  });
}

async function savePendingAccessRequest(id: string) {
  const { getAccessRequestStore } = await import("@/lib/onboarding/access-request-store");
  const now = new Date().toISOString();
  await getAccessRequestStore().save({
    id,
    tenantId,
    name: "Sam Reviewer",
    email: `${id}@example.com`,
    company: "Example Co",
    role: "engineering",
    timeline: "now",
    useCase: "Review the weekly operations summary.",
    status: "pending_review",
    createdAt: now,
    updatedAt: now,
  });
}
