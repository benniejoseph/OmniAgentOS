import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderClient, BuilderScopeChanged } from "./client";
import { digest, projectId, sessionId } from "./fixtures.test-support";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllGlobals());

describe("Builder request lifetime and action response journal", () => {
  it("uses the browser fetch receiver for its default transport", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this instanceof BuilderClient) throw new TypeError("Illegal invocation");
      return Promise.resolve(json({ projectId }));
    });
    const client = new BuilderClient(); const lease = client.configure(true, true);
    await expect(client.json("/api/projects/exact/builder", {}, lease)).resolves.toEqual({ projectId });
  });
  it("makes no requests on an inactive mount or a role without action authority", async () => {
    const transport = vi.fn<typeof fetch>(); const client = new BuilderClient(transport);
    let lease = client.configure(false, true);
    await expect(client.json("/api/private", {}, lease)).rejects.toBeInstanceOf(BuilderScopeChanged);
    lease = client.configure(true, false);
    await expect(client.mutate(projectId, { action: "stop", sessionId }, "key", lease)).rejects.toThrow("current role");
    expect(transport).not.toHaveBeenCalled();
  });
  it("cancels delayed reads and prevents stale leases from dispatching after access returns", async () => {
    const pending = deferred<Response>(); const transport = vi.fn<typeof fetch>().mockReturnValue(pending.promise); const client = new BuilderClient(transport);
    const lease = client.configure(true, true); const read = client.json("/api/private", {}, lease);
    const rejected = expect(read).rejects.toBeInstanceOf(BuilderScopeChanged);
    client.configure(false, false); const next = client.configure(true, true);
    expect((transport.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    pending.resolve(json({ private: "old owner response" })); await rejected;
    await expect(client.mutate(projectId, { action: "stop", sessionId }, "stale", lease)).rejects.toBeInstanceOf(BuilderScopeChanged);
    expect(client.current(next)).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("freezes the dispatched body and retains accepted action evidence across failed reads and evidence refreshes", async () => {
    const pending = deferred<Response>(); const transport = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ error: "read unavailable" }, 503)).mockResolvedValueOnce(json({ deployment: { id: "exact-preview" } }));
    const client = new BuilderClient(transport); const lease = client.configure(true, true);
    const body = { action: "file.update", sessionId, path: "app/page.tsx", expectedSha256: digest, content: "submitted draft" };
    const write = client.mutate(projectId, body, "exact-key", lease); body.content = "later draft";
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).content).toBe("submitted draft");
    expect(transport.mock.calls[0][0]).toBe(`/api/projects/${encodeURIComponent(projectId)}/builder`);
    pending.resolve(json({ serviceReceipt: { receiptSha256: digest }, saved: true })); await write;
    await expect(client.json("/api/read", {}, lease)).rejects.toThrow("read unavailable");
    await client.mutate(projectId, { action: "deployment.refresh", sessionId, deploymentId: "exact-preview" }, "read-evidence", lease);
    expect(client.outcome).toMatchObject({ action: "file.update", key: "exact-key", state: "accepted", receiptSha256: digest });
    expect(client.outcome?.targets).toContainEqual(["path", "app/page.tsx"]);
    expect(JSON.stringify(client.outcome)).not.toContain("submitted draft");
  });
  it.each([409, 500, 503])("keeps HTTP %i outcomes uncertain without blind repeat effects", async (status) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "provider response uncertain" }, status));
    const client = new BuilderClient(transport); const lease = client.configure(true, true);
    await expect(client.mutate(projectId, { action: "command.run", sessionId, command: "build" }, "exact-key", lease)).rejects.toThrow();
    expect(client.outcome?.state).toBe("uncertain");
    client.allowNewDecision(); expect(client.outcome?.state).toBe("uncertain");
    await expect(client.mutate(projectId, { action: "command.run", sessionId, command: "build" }, "different-key", lease)).rejects.toThrow("uncertain outcome");
    expect(transport).toHaveBeenCalledTimes(1);
    client.acknowledgeRefreshedOutcome(); expect(client.canMakeNewDecision()).toBe(true);
    client.allowNewDecision(); expect(client.outcome).toBeUndefined();
  });
  it("keeps a lost mutation uncertain through re-entry, without a late response overwriting a new decision", async () => {
    const pending = deferred<Response>(); const transport = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ accepted: true }));
    const client = new BuilderClient(transport); const old = client.configure(true, true);
    const write = client.mutate(projectId, { action: "stop", sessionId }, "old", old); const rejected = expect(write).rejects.toBeInstanceOf(BuilderScopeChanged);
    client.configure(false, false); const next = client.configure(true, true);
    expect(client.outcome?.state).toBe("uncertain");
    client.acknowledgeRefreshedOutcome(); client.allowNewDecision();
    await client.mutate(projectId, { action: "checkpoint.create", sessionId }, "new", next);
    pending.resolve(json({ accepted: true })); await rejected;
    expect(client.outcome).toMatchObject({ key: "new", state: "accepted" });
  });
  it("keeps mismatched action receipts uncertain rather than switching exact targets", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ release: { id: "other-release", deploymentId: "other-preview" } }));
    const client = new BuilderClient(transport); const lease = client.configure(true, true);
    await expect(client.mutate(projectId, { action: "release.production", sessionId, releaseId: "reviewed-release", releaseDigest: digest }, "exact", lease)).rejects.toThrow("exact submitted target");
    expect(client.outcome?.state).toBe("uncertain"); expect(client.outcome?.targets).toContainEqual(["releaseId", "reviewed-release"]);
  });
  it("rejects known admission failures without claiming acceptance", async () => {
    const client = new BuilderClient(vi.fn<typeof fetch>().mockResolvedValue(json({ error: "denied" }, 403))); const lease = client.configure(true, true);
    await expect(client.mutate(projectId, { action: "stop", sessionId }, "denied", lease)).rejects.toThrow("denied");
    expect(client.outcome?.state).toBe("rejected");
  });
  it("aborts and disposes an Agent stream, suppressing private events after a scope change", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const canceled = vi.fn(); const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, cancel: canceled });
    const client = new BuilderClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))); const lease = client.configure(true, true); const seen = vi.fn();
    const run = client.agent({ requestId: "run-exact", agentId: "forge" }, lease, seen); const rejected = expect(run).rejects.toBeInstanceOf(BuilderScopeChanged);
    // Let the streaming reader attach before delivering an event.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    client.configure(false, false);
    streamController.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"private stale output"}\n\n'));
    await rejected; expect(seen).not.toHaveBeenCalled(); expect(canceled).toHaveBeenCalled(); expect(client.outcome?.state).toBe("uncertain");
  });
  it("requires explicit Agent completion and bounds each streamed event", async () => {
    const client = new BuilderClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"type":"delta","text":"partial"}\n\n'))); const lease = client.configure(true, true);
    await expect(client.agent({ requestId: "partial" }, lease, vi.fn())).rejects.toThrow("completion");
    expect(client.outcome?.state).toBe("uncertain");
    const bounded = new BuilderClient(vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(1_000_001)))); const next = bounded.configure(true, true);
    await expect(bounded.agent({ requestId: "large" }, next, vi.fn())).rejects.toThrow("bounded display limit");
  });
});
