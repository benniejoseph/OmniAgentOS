import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkWorkerCompatibility,
  WORKER_PROTOCOL_VERSION,
} from "@/lib/operations/worker-request";
import { workerHeartbeatId } from "@/lib/operations/worker-heartbeat";

describe("worker protocol compatibility", () => {
  it("tracks each worker lane independently", () => {
    expect(workerHeartbeatId("worker-a", "fast")).not.toBe(
      workerHeartbeatId("worker-a", "background"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts compatible workers even when release revisions differ", () => {
    vi.stubEnv("OMNIAGENT_RELEASE_SHA", "release-a");
    expect(
      checkWorkerCompatibility(
        requestWithWorkerHeaders({
          protocol: WORKER_PROTOCOL_VERSION,
          revision: "release-b",
        }),
      ),
    ).toMatchObject({
      accepted: true,
      expectedProtocol: WORKER_PROTOCOL_VERSION,
      providedProtocol: WORKER_PROTOCOL_VERSION,
      activeRevision: "release-a",
      providedRevision: "release-b",
    });
  });

  it("rejects missing and unsupported protocol versions", () => {
    expect(checkWorkerCompatibility(requestWithWorkerHeaders())).toMatchObject({
      accepted: false,
      status: 409,
    });
    expect(
      checkWorkerCompatibility(
        requestWithWorkerHeaders({ protocol: "unsupported" }),
      ),
    ).toMatchObject({
      accepted: false,
      status: 409,
      expectedProtocol: WORKER_PROTOCOL_VERSION,
      providedProtocol: "unsupported",
    });
  });

  it("supports an explicit protocol rollout override", () => {
    vi.stubEnv("OMNIAGENT_WORKER_PROTOCOL_VERSION", "2");
    expect(
      checkWorkerCompatibility(requestWithWorkerHeaders({ protocol: "2" })),
    ).toMatchObject({
      accepted: true,
      expectedProtocol: "2",
    });
  });
});

function requestWithWorkerHeaders({
  protocol,
  revision,
}: {
  protocol?: string;
  revision?: string;
} = {}) {
  return new Request("https://example.test/api/workflows/tick", {
    method: "POST",
    headers: {
      ...(protocol ? { "x-omni-worker-protocol": protocol } : {}),
      ...(revision ? { "x-omni-worker-revision": revision } : {}),
    },
  });
}
