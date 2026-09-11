import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-operations-overview-"),
  );
  delete process.env.DATABASE_URL;
});

describe("operations overview", () => {
  it("excludes actor-private semantic jobs and projects visible jobs", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-overview-private-jobs";
    const visible = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      payload: {
        workflowRunId: "visible-workflow",
        request: { privateInput: "must-not-reach-overview" },
      },
    });
    await queue.enqueueOperationJob({
      tenantId,
      type: "conversation.summary.enrich",
      payload: {
        actorId: "private-actor",
        request: { transcript: "private transcript" },
        result: { sourceSha256: "private-source-hash" },
      },
    });

    const overview = await operations.getOperationsOverview({ tenantId });

    expect(overview.latest.operationJobs).toEqual([
      expect.objectContaining({ id: visible.id, type: "workflow.tick" }),
    ]);
    expect(overview.latest.operationJobs[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(overview.latest.operationJobs)).not.toContain(
      "private transcript",
    );
    expect(JSON.stringify(overview.latest.operationJobs)).not.toContain(
      "must-not-reach-overview",
    );
  });
});
