import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getAgentRun: vi.fn(),
  getOwnedThread: vi.fn(),
  getRunBrowserFrameContent: vi.fn(),
  getRunBrowserAccessibilitySnapshotContent: vi.fn(),
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
  getRunBrowserAccessibilitySnapshotContent:
    routeMocks.getRunBrowserAccessibilitySnapshotContent,
}));

import { GET as GETActivity } from "@/app/api/runs/[id]/activity/route";
import { GET as GETFrame } from "@/app/api/runs/[id]/activity/frames/[frameId]/route";
import { GET as GETSnapshot } from "@/app/api/runs/[id]/activity/snapshots/[snapshotId]/route";

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
  routeMocks.getRunBrowserAccessibilitySnapshotContent.mockReset();
  routeMocks.listRunBrowserActivity.mockReset();
});

describe("private run activity failures", () => {
  it("returns the same private no-store policy when the run is absent", async () => {
    routeMocks.getAgentRun.mockResolvedValue(null);

    const activityResponse = await getActivity("missing-run");
    const frameResponse = await getFrame("missing-run", "missing-frame");
    const snapshotResponse = await getSnapshot("missing-run", "missing-snapshot");

    expectPrivateNotFound(activityResponse);
    expectPrivateNotFound(frameResponse);
    expectPrivateNotFound(snapshotResponse);
    expect(routeMocks.listRunBrowserActivity).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserFrameContent).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserAccessibilitySnapshotContent).not.toHaveBeenCalled();
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
    const snapshotResponse = await getSnapshot("run-a", "snapshot-a");

    expectPrivateNotFound(activityResponse);
    expectPrivateNotFound(frameResponse);
    expectPrivateNotFound(snapshotResponse);
    expect(routeMocks.getOwnedThread).toHaveBeenCalledTimes(3);
    expect(routeMocks.listRunBrowserActivity).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserFrameContent).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserAccessibilitySnapshotContent).not.toHaveBeenCalled();
  });

  it("keeps an absent accessibility snapshot private after its owner resolves", async () => {
    routeMocks.getAgentRun.mockResolvedValue({
      id: "run-a",
      ownerActorId: auth.actorId,
      status: "completed",
    });
    routeMocks.getRunBrowserAccessibilitySnapshotContent.mockResolvedValue(null);

    const response = await getSnapshot("run-a", "missing-snapshot");

    expectPrivateNotFound(response);
    expect(routeMocks.getRunBrowserAccessibilitySnapshotContent).toHaveBeenCalledWith(
      "run-a",
      "missing-snapshot",
      { tenantId: auth.tenantId, actorId: auth.actorId },
    );
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

  it("does not expose an unthreaded sibling actor's observation content", async () => {
    routeMocks.getAgentRun.mockResolvedValue({
      id: "run-a",
      ownerActorId: "sibling@example.test",
      status: "completed",
    });

    const frameResponse = await getFrame("run-a", "frame-a");
    const snapshotResponse = await getSnapshot("run-a", "snapshot-a");

    expectPrivateNotFound(frameResponse);
    expectPrivateNotFound(snapshotResponse);
    expect(routeMocks.getRunBrowserFrameContent).not.toHaveBeenCalled();
    expect(routeMocks.getRunBrowserAccessibilitySnapshotContent).not.toHaveBeenCalled();
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

function getSnapshot(runId: string, snapshotId: string) {
  return GETSnapshot(
    new Request(`http://localhost/api/runs/${runId}/activity/snapshots/${snapshotId}`),
    { params: Promise.resolve({ id: runId, snapshotId }) },
  );
}

function expectPrivateNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}
