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

import { GET } from "@/app/api/approvals/route";

const tenantId = "tenant-approvals-route";

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-approvals-route-"),
  );
  delete process.env.DATABASE_URL;
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId,
    actorId: "queue-owner",
    role: "operator",
    source: "session",
  });
});

describe("GET /api/approvals", () => {
  it("pages the queue with a cursor and private headers", async () => {
    await savePendingToolApproval("tool-oldest", 3);
    await savePendingToolApproval("tool-middle", 2);
    await savePendingToolApproval("tool-newest", 1);

    const first = await GET(request("/api/approvals?limit=2"));
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(firstBody.items.map((item: { id: string }) => item.id)).toEqual([
      "tool-oldest",
      "tool-middle",
    ]);
    expect(firstBody.stats).toEqual({
      total: 3,
      tools: 3,
      reconciliations: 0,
      workflows: 0,
      sloPolicies: 0,
    });
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "manage.workflow",
      resourceType: "approval_queue",
      resourceId: undefined,
      metadata: { limit: 2 },
    }));

    const second = await GET(request(
      `/api/approvals?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    ));
    const secondBody = await second.json();

    expect(secondBody.items.map((item: { id: string }) => item.id)).toEqual([
      "tool-newest",
    ]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("reads 25 items unless asked for fewer, and never more than 100", async () => {
    for (const [query, limit] of [["", 25], ["?limit=500", 100]] as const) {
      const response = await GET(request(`/api/approvals${query}`));

      expect(response.status).toBe(200);
      expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
        metadata: { limit },
      }));
    }
  });

  it("refuses a cursor it did not issue", async () => {
    const response = await GET(request("/api/approvals?cursor=bm90LWEtY3Vyc29y"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "The approvals cursor is invalid.",
    });
  });

  it("refuses an unknown kind", async () => {
    const response = await GET(request("/api/approvals?id=tool-oldest&kind=job"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "kind must be tool, workflow, or slo_policy.",
    });
  });

  it("returns one pending approval by id, with its origin for the owner", async () => {
    const runs = await import("@/lib/runs/store");
    await savePendingToolApproval("tool-deep-link", 2);
    const run = await runs.createAgentRun({
      mode: "orchestrate",
      prompt: "Check the status page.",
      messages: [{ role: "user", content: "Check the status page." }],
      tenantId,
      actorId: "queue-owner",
      threadId: "thread-deep-link",
    });
    await runs.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: {
        conversationItems: [{ role: "user", content: "test" }],
        instructions: "test",
        response: "partial",
        toolSteps: 1,
        outputsBeforeApproval: [],
        pendingToolCall: {
          callId: "call_1",
          toolId: "http.request",
          toolName: "HTTP Request",
          riskLevel: 2,
          executionId: "tool-deep-link",
        },
        context: { tenantId, actorId: "queue-owner", role: "operator" },
        createdAt: new Date().toISOString(),
      },
    });

    const response = await GET(request("/api/approvals?id=%20tool-deep-link%20&kind=tool"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.item).toMatchObject({
      kind: "tool",
      id: "tool-deep-link",
      origin: { runId: run.id, threadId: "thread-deep-link" },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "manage.workflow",
      resourceType: "approval_queue",
      resourceId: "tool-deep-link",
      metadata: { operation: "read_approval", kind: "tool" },
    }));

    const missing = await GET(request("/api/approvals?id=tool-missing"));
    await expect(missing.json()).resolves.toEqual({ item: null });
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      resourceId: "tool-missing",
      metadata: { operation: "read_approval", kind: "any" },
    }));

    const list = await GET(request("/api/approvals"));
    const listBody = await list.json();
    expect(listBody.items).toEqual([
      expect.objectContaining({
        id: "tool-deep-link",
        origin: { runId: run.id, threadId: "thread-deep-link" },
      }),
    ]);
  });

  it("looks an id up only in the kind asked for", async () => {
    await savePendingToolApproval("tool-kind", 1);

    for (const kind of ["workflow", "slo_policy"]) {
      const response = await GET(request(`/api/approvals?id=tool-kind&kind=${kind}`));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ item: null });
      expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
        resourceId: "tool-kind",
        metadata: { operation: "read_approval", kind },
      }));
    }
  });

  it("refuses an id over 200 characters without recording it", async () => {
    const id = "x".repeat(201);
    const response = await GET(request(`/api/approvals?id=${id}`));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "id must be at most 200 characters.",
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: undefined,
    }));

    const longest = await GET(request(`/api/approvals?id=${"x".repeat(200)}`));
    expect(longest.status).toBe(200);
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      resourceId: "x".repeat(200),
    }));
  });

  it("answers a caller without access before reading anything", async () => {
    mocks.authorizeRequest.mockRejectedValue(
      new SecurityPolicyError("Role viewer cannot perform manage.workflow.", 403),
    );

    const response = await GET(request("/api/approvals?cursor=invalid!"));

    expect(response.status).toBe(403);
  });
});

function request(pathAndQuery: string) {
  return new Request(`https://asael.test${pathAndQuery}`);
}

async function savePendingToolApproval(id: string, daysAgo: number) {
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
    input: { url: `https://status.example.com/${id}` },
    createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  });
}
