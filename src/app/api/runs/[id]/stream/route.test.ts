import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/guard")>();
  return { ...actual, authorizeRequest: vi.fn(actual.authorizeRequest) };
});

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-run-stream-route-"),
  );
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = "run-stream-route-test-secret";
  delete process.env.DATABASE_URL;
});

function streamRequest(
  runId: string,
  tenantId: string,
  actorId: string,
  options: { lastEventId?: string; query?: string } = {},
) {
  return new Request(
    `http://asael.test/api/runs/${encodeURIComponent(runId)}/stream${options.query ?? ""}`,
    {
      headers: {
        "x-omni-tenant-id": tenantId,
        "x-omni-user-id": actorId,
        "x-omni-user-role": "admin",
        ...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
      },
    },
  );
}

function blocks(text: string) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines.find((line) => line.startsWith("data: "))!.slice(6);
    return { ...(id ? { id } : {}), event: JSON.parse(data) };
  });
}

async function completedRun(tenantId: string, actorId: string) {
  const runs = await import("@/lib/runs/store");
  const { createThread } = await import("@/lib/threads/store");
  const thread = await createThread({
    tenantId,
    actorId,
    title: "Weekly summary",
    mode: "orchestrate",
  });
  const run = await runs.createAgentRun({
    tenantId,
    actorId,
    threadId: thread.id,
    mode: "orchestrate",
    prompt: "Summarize my week.",
    messages: [{ role: "user", content: "Summarize my week." }],
  });
  const first = await runs.appendRunEvent(
    run.id,
    { type: "status", label: "Planning" },
    { tenantId },
  );
  const second = await runs.appendRunEvent(
    run.id,
    { type: "status", label: "Checking sources" },
    { tenantId },
  );
  await runs.completeAgentRun(run.id, "Answer.", undefined, { tenantId });
  return { run, first, second };
}

describe("GET /api/runs/:id/stream", () => {
  it("replays the owner's run after the last event received, then its outcome", async () => {
    const { GET } = await import("@/app/api/runs/[id]/stream/route");
    const tenantId = "run-stream-tenant";
    const actorId = "run-stream-owner";
    const { run, first, second } = await completedRun(tenantId, actorId);
    expect(first.seq).toEqual(expect.any(Number));
    expect(second.seq).toBeGreaterThan(first.seq!);

    const response = await GET(
      streamRequest(run.id, tenantId, actorId, { lastEventId: String(first.seq) }),
      { params: Promise.resolve({ id: run.id }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(response.headers.get("x-asael-run-id")).toBe(run.id);
    expect(blocks(await response.text())).toEqual([
      { event: { type: "run", runId: run.id, threadId: run.threadId } },
      { id: String(second.seq), event: { type: "status", label: "Checking sources" } },
      { event: { type: "done", response: "Answer." } },
    ]);

    const fromQuery = await GET(
      streamRequest(run.id, tenantId, actorId, { query: `?after=${second.seq}` }),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(blocks(await fromQuery.text())).toEqual([
      { event: { type: "run", runId: run.id, threadId: run.threadId } },
      { event: { type: "done", response: "Answer." } },
    ]);
  });

  it("hides a run from another member and from another tenant", async () => {
    const { GET } = await import("@/app/api/runs/[id]/stream/route");
    const tenantId = "run-stream-boundary-tenant";
    const { run } = await completedRun(tenantId, "run-stream-boundary-owner");

    for (const [otherTenant, otherActor] of [
      [tenantId, "run-stream-boundary-sibling"],
      ["run-stream-other-tenant", "run-stream-boundary-owner"],
    ]) {
      const response = await GET(
        streamRequest(run.id, otherTenant, otherActor),
        { params: Promise.resolve({ id: run.id }) },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({ error: "Run not found." });
    }
  });

  it("authorizes the read of that run before it looks the run up", async () => {
    const { authorizeRequest } = await import("@/lib/security/guard");
    const { SecurityPolicyError } = await import("@/lib/security/context");
    const { GET } = await import("@/app/api/runs/[id]/stream/route");
    vi.mocked(authorizeRequest).mockRejectedValueOnce(
      new SecurityPolicyError("Role viewer cannot perform read.", 403),
    );

    // No such run exists, so a lookup ahead of the check would answer 404.
    const request = streamRequest("run-stream-denied", "run-stream-denied-tenant", "viewer");
    const response = await GET(request, {
      params: Promise.resolve({ id: "run-stream-denied" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden" });
    expect(authorizeRequest).toHaveBeenLastCalledWith({
      request,
      action: "read",
      resourceType: "agent_run",
      resourceId: "run-stream-denied",
    });
  });
});
