import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getAgentRun: vi.fn(),
  getOwnedThread: vi.fn(),
  getRunBrowserFrameContent: vi.fn(),
  listRunBrowserActivity: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: routeMocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/runs/store", () => ({
  getAgentRun: routeMocks.getAgentRun,
}));

vi.mock("@/lib/threads/store", () => ({
  getOwnedThread: routeMocks.getOwnedThread,
}));

vi.mock("@/lib/runs/activity", () => ({
  listRunBrowserActivity: routeMocks.listRunBrowserActivity,
}));

vi.mock("@/lib/browser/frames", () => ({
  getRunBrowserFrameContent: routeMocks.getRunBrowserFrameContent,
}));

import { GET as GETActivity } from "@/app/api/runs/[id]/activity/route";
import { GET as GETFrame } from "@/app/api/runs/[id]/activity/frames/[frameId]/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const auth = {
  tenantId: "tenant-a",
  actorId: "thread-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: "thread-owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(auth);
  routeMocks.getAgentRun.mockReset();
  routeMocks.getOwnedThread.mockReset();
  routeMocks.getRunBrowserFrameContent.mockReset();
  routeMocks.listRunBrowserActivity.mockReset();
});

describe("private run activity failures", () => {
  it("returns the same private no-store policy when the run is absent", async () => {
    routeMocks.getAgentRun.mockResolvedValue(null);

    const activityResponse = await getActivity("missing-run");
    const frameResponse = await getFrame("missing-run", "missing-frame");

    expectPrivateNotFound(activityResponse);
    expectPrivateNotFound(frameResponse);
    expect(routeMocks.listRunBrowserActivity).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserFrameContent).not.toHaveBeenCalled();
  });

  it("short-circuits both child reads when the parent thread is inaccessible", async () => {
    routeMocks.getAgentRun.mockResolvedValue({
      id: "run-a",
      status: "completed",
      threadId: "inaccessible-thread",
    });
    routeMocks.getOwnedThread.mockResolvedValue(null);

    const activityResponse = await getActivity("run-a");
    const frameResponse = await getFrame("run-a", "frame-a");

    expectPrivateNotFound(activityResponse);
    expectPrivateNotFound(frameResponse);
    expect(routeMocks.getOwnedThread).toHaveBeenCalledTimes(2);
    expect(routeMocks.listRunBrowserActivity).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserFrameContent).not.toHaveBeenCalled();
  });

  it("keeps an absent frame private after the parent thread resolves", async () => {
    routeMocks.getAgentRun.mockResolvedValue({
      id: "run-a",
      status: "completed",
      threadId: "thread-a",
    });
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: auth.tenantId,
      actorId: auth.actorId,
    });
    routeMocks.getRunBrowserFrameContent.mockResolvedValue(null);

    const response = await getFrame("run-a", "missing-frame");

    expectPrivateNotFound(response);
    expect(routeMocks.getRunBrowserFrameContent).toHaveBeenCalledWith(
      "run-a",
      "missing-frame",
      { tenantId: auth.tenantId, actorId: auth.actorId },
    );
  });
});

function getActivity(runId: string) {
  return GETActivity(
    new Request(`http://localhost/api/runs/${runId}/activity`),
    { params: Promise.resolve({ id: runId }) },
  );
}

function getFrame(runId: string, frameId: string) {
  return GETFrame(
    new Request(`http://localhost/api/runs/${runId}/activity/frames/${frameId}`),
    { params: Promise.resolve({ id: runId, frameId }) },
  );
}

function expectPrivateNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}
