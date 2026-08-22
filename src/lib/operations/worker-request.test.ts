import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWorkerRevision } from "@/lib/operations/worker-request";

describe("worker revision fencing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the exact active release revision", () => {
    vi.stubEnv("OMNIAGENT_RELEASE_SHA", "release-a");
    expect(
      checkWorkerRevision(
        requestWithRevision("release-a"),
      ),
    ).toMatchObject({
      accepted: true,
      expectedRevision: "release-a",
      providedRevision: "release-a",
    });
  });

  it("rejects missing and stale worker revisions", () => {
    vi.stubEnv("OMNIAGENT_RELEASE_SHA", "release-a");
    expect(checkWorkerRevision(requestWithRevision())).toMatchObject({
      accepted: false,
      status: 409,
    });
    expect(checkWorkerRevision(requestWithRevision("release-b"))).toMatchObject({
      accepted: false,
      status: 409,
      expectedRevision: "release-a",
      providedRevision: "release-b",
    });
  });

  it("fails closed when production has no web revision", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_RELEASE_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect(checkWorkerRevision(requestWithRevision("release-a"))).toMatchObject({
      accepted: false,
      status: 503,
    });
  });
});

function requestWithRevision(revision?: string) {
  return new Request("https://example.test/api/workflows/tick", {
    method: "POST",
    headers: revision
      ? { "x-omni-worker-revision": revision }
      : undefined,
  });
}
