import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: vi.fn() }));
vi.mock("@/lib/app-services/conversation-canvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/conversation-canvas")>()),
  showConversationCanvasService: mocks.show,
}));

import { GET } from "@/app/api/conversations/canvas/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({
    tenantId: "tenant:test", actorId: "actor:test", role: "admin", source: "session",
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { projection: { version: "p11.3-conversation-canvas:1" } },
    receipt: { operation: "app.conversations.canvas.show" },
  });
});

describe("Conversation canvas route", () => {
  it("returns the exact private bounded projection", async () => {
    const response = await GET(new Request(
      "http://localhost/api/conversations/canvas?threadId=thread-1&runLimit=20&artifactLimit=10",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "conversation_canvas",
      resourceId: "thread-1",
    }));
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), {
      threadId: "thread-1",
      threadLimit: 24,
      runLimit: 20,
      artifactLimit: 10,
    });
  });

  it("rejects invalid bounds before authorization", async () => {
    const response = await GET(new Request(
      "http://localhost/api/conversations/canvas?runLimit=201",
    ));
    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
