import type { AgentEvent } from "./model";
import { assertMutationIdentity } from "./state";

export class BuilderScopeChanged extends Error { constructor() { super("Builder access changed. Refresh the current workspace before continuing."); } }
export type BuilderActionOutcome = Readonly<{ action: string; key: string; state: "pending" | "accepted" | "rejected" | "uncertain"; targets: ReadonlyArray<readonly [string, string]>; receiptSha256?: string; detail?: string }>;
/** One instance per exact owner/role/deployment/project. No mutation is replayed here. */
export class BuilderClient {
  private epoch = 0;
  private available = false;
  private writable = false;
  private controllers = new Set<AbortController>();
  outcome?: BuilderActionOutcome;
  private outcomeRevision = 0;
  private outcomeReviewed = false;
  constructor(private transport: typeof fetch = (input, init) => fetch(input, init)) {}
  configure(available: boolean, writable: boolean) {
    if (this.available !== available || this.writable !== writable) {
      this.epoch += 1;
      if (this.outcome?.state === "pending") this.outcome = { ...this.outcome, state: "uncertain" };
      this.outcomeReviewed = false;
      this.cancel();
      this.available = available;
      this.writable = writable;
    }
    return this.epoch;
  }
  cancel() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
  current(lease: number) { return this.available && lease === this.epoch; }
  assert(lease: number) { if (!this.current(lease)) throw new BuilderScopeChanged(); }
  async request(path: string, init: RequestInit, lease: number) {
    this.assert(lease);
    if (init.method === "POST" && !this.writable) throw new Error("Your current role can inspect Builder but cannot execute its actions.");
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await this.transport(path, { cache: "no-store", ...init, signal: controller.signal });
      this.assert(lease);
      if (controller.signal.aborted) throw new BuilderScopeChanged();
      return { response, controller, finish: () => this.controllers.delete(controller) };
    } catch (error) {
      this.controllers.delete(controller);
      if (!this.current(lease) || controller.signal.aborted) throw new BuilderScopeChanged();
      throw error;
    }
  }
  async json<T>(path: string, init: RequestInit, lease: number): Promise<T> {
    const { response, controller, finish } = await this.request(path, init, lease);
    try {
      const value: unknown = await response.json(); this.assert(lease);
      if (controller.signal.aborted) throw new BuilderScopeChanged();
      if (!response.ok) {
        const body = value as { error?: unknown; message?: unknown };
        throw new BuilderResponseError(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : `Builder returned ${response.status}.`, response.status);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Builder returned an invalid response.");
      return value as T;
    } catch (error) {
      if (!this.current(lease) || controller.signal.aborted) throw new BuilderScopeChanged();
      throw error;
    } finally { finish(); }
  }
  async mutate<T>(projectId: string, body: Record<string, unknown>, key: string, lease: number): Promise<T> {
    this.assert(lease);
    if (!this.writable) throw new Error("Your current role cannot execute Builder actions.");
    // Serialize once before awaiting; subsequent form edits cannot change the request or its validation basis.
    const serialized = JSON.stringify(body);
    const submitted = JSON.parse(serialized) as Record<string, unknown>;
    if (submitted.action === "deployment.refresh" || submitted.action === "release.refresh") {
      const value = await this.json<T>(`/api/projects/${encodeURIComponent(projectId)}/builder`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: serialized }, lease);
      assertMutationIdentity(value, projectId, submitted); return value;
    }
    if (this.outcome?.state === "pending" || this.outcome?.state === "uncertain") throw new Error("The previous action has an uncertain outcome. Refresh the workspace and review its recorded state before another action.");
    const action = String(submitted.action);
    const targets = ["sessionId", "path", "checkpointId", "verificationId", "repositoryBindingId", "repositoryId", "deploymentId", "releaseId", "releaseDigest"].flatMap((field) => typeof submitted[field] === "string" ? [[field, submitted[field]] as const] : []);
    const revision = ++this.outcomeRevision; this.outcomeReviewed = false;
    this.outcome = { action, key, targets, state: "pending" };
    try {
      const value = await this.json<T>(`/api/projects/${encodeURIComponent(projectId)}/builder`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: serialized }, lease);
      assertMutationIdentity(value, projectId, submitted);
      const receipt = (value as { serviceReceipt?: { receiptSha256?: unknown } }).serviceReceipt?.receiptSha256;
      if (revision === this.outcomeRevision) this.outcome = { action, key, targets, state: "accepted", ...(typeof receipt === "string" && /^[a-f0-9]{64}$/.test(receipt) ? { receiptSha256: receipt } : {}) };
      return value;
    } catch (error) {
      // 409 can describe an operation which reached a provider before failing.
      // Only admission failures prove that this request was rejected before an effect.
      if (revision === this.outcomeRevision) this.outcome = { action, key, targets, state: error instanceof BuilderResponseError && [400, 401, 403, 404, 422, 429].includes(error.status) ? "rejected" : "uncertain", detail: error instanceof Error ? error.message : "Response unavailable." };
      throw error;
    }
  }
  canMakeNewDecision() { return this.outcome?.state === "uncertain" && this.outcomeReviewed; }
  acknowledgeRefreshedOutcome() {
    this.outcomeReviewed = this.outcome?.state === "uncertain";
    if (this.outcome?.state === "uncertain") this.outcome = { ...this.outcome, detail: "A fresh snapshot was loaded. The interrupted action is still unconfirmed; inspect Activity and provider evidence before deciding whether to perform another action." };
  }
  allowNewDecision() { if (this.canMakeNewDecision()) { this.outcomeRevision += 1; this.outcome = undefined; this.outcomeReviewed = false; } }
  async agent(body: unknown, lease: number, onEvent: (event: AgentEvent) => void) {
    this.assert(lease);
    if (!this.writable || this.outcome?.state === "pending" || this.outcome?.state === "uncertain") throw new Error("Inspect the previous action before starting another Agent request.");
    const revision = ++this.outcomeRevision; this.outcomeReviewed = false;
    const input = body as { requestId?: string; agentId?: string };
    const outcome: BuilderActionOutcome = { action: `agent.${input.agentId || "request"}`, key: input.requestId || "unavailable", targets: [], state: "pending" };
    this.outcome = outcome;
    let completed = false;
    let request: Awaited<ReturnType<BuilderClient["request"]>>;
    try { request = await this.request("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, lease); }
    catch (error) { if (revision === this.outcomeRevision) this.outcome = { ...outcome, state: "uncertain" }; throw error; }
    const { response, controller, finish } = request;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!response.ok || !response.body) throw new Error(`Agent response unavailable (${response.status}). Check Command for its run state.`);
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const emit = (block: string) => {
        this.assert(lease); if (controller.signal.aborted) throw new BuilderScopeChanged();
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
        if (data) { const event = JSON.parse(data) as AgentEvent; if (event.type === "done") completed = true; onEvent(event); }
      };
      while (true) {
        const next = await reader.read(); this.assert(lease);
        if (controller.signal.aborted) throw new BuilderScopeChanged();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 1_000_000) throw new Error("Agent event exceeds the bounded display limit. Inspect its run in Command.");
        const blocks = buffer.replaceAll("\r\n", "\n").split("\n\n"); buffer = blocks.pop() || ""; blocks.forEach(emit);
      }
      buffer += decoder.decode(); buffer.replaceAll("\r\n", "\n").split("\n\n").forEach(emit);
      if (!completed) throw new Error("Agent completion was not received. Inspect Command for its exact run state.");
      if (revision === this.outcomeRevision) this.outcome = { ...outcome, state: "accepted" };
    } catch (error) {
      if (revision === this.outcomeRevision) this.outcome = { ...outcome, state: "uncertain" };
      if (!this.current(lease) || controller.signal.aborted) throw new BuilderScopeChanged();
      throw error;
    } finally { await reader?.cancel().catch(() => undefined); finish(); }
  }
}
class BuilderResponseError extends Error { constructor(message: string, readonly status: number) { super(message); } }
