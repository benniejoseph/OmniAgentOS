import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(() => Response.json({ error: "forbidden" }, { status: 403 })),
}));

import { POST } from "@/app/api/retrieval/selection-lock/route";
import { issueContextSelectionPreview } from "@/lib/rag/context-selection-lock";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "admin" as const,
  source: "session" as const,
};

describe("context selection lock route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "context-lock-route-test-secret");
    mocks.authorizeRequest.mockResolvedValue(context);
  });

  it("locks an authenticated subset and returns only content-free receipt metadata", async () => {
    const preview = issueContextSelectionPreview({
      tenantId: context.tenantId,
      actorId: context.actorId,
      query: "Restore the database",
      candidateEvidenceIds: ["knowledge:restore", "memory:preference"],
      contextPackSha256: "a".repeat(64),
    });
    const response = await POST(request(preview.token, ["knowledge:restore"]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({
      selection: {
        query: "Restore the database",
        evidenceIds: ["knowledge:restore"],
        lockToken: expect.any(String),
      },
      receipt: {
        evidenceIds: ["knowledge:restore"],
        excludedEvidenceIds: ["memory:preference"],
        selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(body)).not.toContain("private context");
  });

  it("rejects a preview issued to another actor", async () => {
    const preview = issueContextSelectionPreview({
      tenantId: context.tenantId,
      actorId: "actor-b",
      query: "Restore the database",
      candidateEvidenceIds: ["knowledge:restore"],
      contextPackSha256: "b".repeat(64),
    });
    const response = await POST(request(preview.token, ["knowledge:restore"]));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Context selection could not be locked.",
      message: expect.stringMatching(/another workspace actor/i),
    });
  });
});

function request(previewToken: string, evidenceIds: string[]) {
  return new Request("http://asael.test/api/retrieval/selection-lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "Restore the database",
      evidenceIds,
      previewToken,
    }),
  });
}
