import { readDetail, readList, readObservations, readReferences, readRuntime, requestJson, ResponseError, verifyDraftResult, verifyRuntimeResult } from "./client";
import { responsibilityApi, type Detail, type DraftResult, type ObservationView, type Owner, type References, type ResponsibilityLifecycleRequest, type ResponsibilityMutation, type ResponsibilityRecord, type RuntimeResult, type RuntimeView } from "./model";
import { readNotifications, verifyNotificationsResult } from "./notifications-client";
import type { NotificationControlRequest, NotificationsResult, NotificationsView } from "./notifications-model";

export type Resource<T> = { state: "idle" | "loading" | "ready" | "error"; value?: T; error?: string };
export type Submission = { kind: "draft"; id?: string; body: ResponsibilityMutation } | { kind: "runtime"; id: string; body: ResponsibilityLifecycleRequest } | { kind: "notifications"; id: string; body: NotificationControlRequest };
export type PendingSubmission = Submission & { key: string; uncertain?: boolean };
export type ResponsibilityState = {
  list: Resource<{ records: ResponsibilityRecord[]; hasMore: boolean }>; detail: Resource<Detail>;
  runtime: Resource<RuntimeView>; observations: Resource<ObservationView>; references: Resource<References>; notifications: Resource<NotificationsView>;
  pending?: PendingSubmission; submitting: boolean; mutationError?: string;
  accepted?: { kind: "draft"; result: DraftResult } | { kind: "runtime"; result: RuntimeResult } | { kind: "notifications"; result: NotificationsResult };
};
const initial = (): ResponsibilityState => ({ list: { state: "idle" }, detail: { state: "idle" }, runtime: { state: "idle" }, observations: { state: "idle" }, references: { state: "idle" }, notifications: { state: "idle" }, submitting: false });
type Dependencies = { request: typeof requestJson; key: () => string };
/** One request epoch per resource plus a scope epoch. Aborts are an optimization;
 * both epochs are checked after transport AND asynchronous receipt verification. */
export class ResponsibilityController {
  private state = initial(); private listeners = new Set<() => void>(); private active = false; private generation = 0;
  private channels = new Map<string, AbortController>(); private boundActor?: string;
  constructor(readonly scope: string, private owner: Owner, private deps: Dependencies = { request: requestJson, key: () => crypto.randomUUID() }) { this.boundActor = owner.actorId; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<ResponsibilityState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active; this.generation++;
    for (const abort of this.channels.values()) abort.abort(); this.channels.clear();
    if (!active && this.state.submitting) this.emit({ submitting: false,
      ...(this.state.pending?.kind === "notifications" ? { pending: { ...this.state.pending, uncertain: true } } : {}),
      mutationError: "Session changed while the submitted request was outstanding. Its result is unconfirmed; the exact request is retained for this account." });
  }
  dispose() { this.setActive(false); this.listeners.clear(); }
  clearAccepted() { if (!this.state.pending && !this.state.submitting) this.emit({ accepted: undefined }); }
  private start(channel: string) {
    this.channels.get(channel)?.abort(); const abort = new AbortController(); this.channels.set(channel, abort);
    const generation = this.generation;
    return { signal: abort.signal, current: () => this.active && !abort.signal.aborted && generation === this.generation && this.channels.get(channel) === abort };
  }
  private exactOwner(): Owner { return { ...this.owner, actorId: this.boundActor }; }
  private bind(actorId: string) { if (this.boundActor && this.boundActor !== actorId) throw new Error("The response owner changed. Reload this account."); this.boundActor = actorId; }
  async load<K extends "list" | "detail" | "runtime" | "observations" | "references" | "notifications">(kind: K, id?: string, preview = false, limit = 40) {
    if (!this.active) return;
    const flight = this.start(kind); this.emit({ [kind]: { ...this.state[kind], state: "loading", error: undefined } });
    try {
      const path = kind === "list" ? `/api/responsibilities?limit=${limit}` : kind === "references" ? "/api/responsibilities/references" :
        `${responsibilityApi(id!)}${kind === "runtime" ? `/lifecycle${preview ? "?view=activation" : ""}` : kind === "notifications" ? `/notifications${preview ? "?view=enable" : ""}` : kind === "observations" ? "/observations?limit=25" : preview ? "?view=review" : ""}`;
      const raw = await this.deps.request(path, flight.signal); if (!flight.current()) return;
      const owner = this.exactOwner();
      const value = kind === "list" ? await readList(raw, owner, limit) : kind === "detail" ? await readDetail(raw, owner, id!) : kind === "runtime" ? await readRuntime(raw, owner, id!) :
        kind === "observations" ? await readObservations(raw, owner, id!) : kind === "notifications" ? await readNotifications(raw, owner, id!) : readReferences(raw, owner);
      if (!flight.current()) return;
      if (kind === "detail") this.bind((value as Detail).record.actorId);
      if (kind === "references") this.bind((value as References).owner.actorId);
      if (kind === "list" && (value as { records: ResponsibilityRecord[] }).records.length) this.bind((value as { records: ResponsibilityRecord[] }).records[0].actorId);
      this.emit({ [kind]: { state: "ready", value } });
    } catch (error) {
      if (flight.current()) this.emit({ [kind]: { ...this.state[kind], state: "error", error: error instanceof Error ? error.message : "This view is unavailable." } });
    }
  }
  async open(id?: string) {
    // Serial reads respect the hosted single-connection pool. Group failures
    // remain independent; a missing picker never turns a saved draft into empty.
    await this.load("references");
    if (!id) { await this.load("list"); return; }
    await this.load("detail", id); await this.load("runtime", id); await this.load("observations", id); await this.load("notifications", id);
  }
  async submit(input: Submission) {
    if (!this.active || this.state.pending || this.state.submitting) return;
    // Freeze by value before generating the key. All retries use this exact pair.
    const pending = { ...JSON.parse(JSON.stringify(input)), key: this.deps.key() } as PendingSubmission;
    this.emit({ pending, accepted: undefined, mutationError: undefined });
    await this.sendPending();
  }
  retry = async () => { if (this.active && this.state.pending && !this.state.submitting) await this.sendPending(); };
  private async sendPending() {
    const pending = this.state.pending; if (!pending || !this.active) return;
    const flight = this.start("mutation"); this.emit({ submitting: true, mutationError: undefined });
    try {
      const path = pending.kind === "runtime" ? `${responsibilityApi(pending.id)}/lifecycle` : pending.kind === "notifications" ? `${responsibilityApi(pending.id)}/notifications` : pending.id ? responsibilityApi(pending.id) : "/api/responsibilities";
      const raw = await this.deps.request(path, flight.signal, { method: pending.kind === "draft" && pending.body.action !== "create" ? "PATCH" : "POST", key: pending.key, body: pending.body });
      if (!flight.current()) return;
      if (pending.kind === "draft") {
        const result = await verifyDraftResult(raw, this.exactOwner(), pending.body, pending.key, pending.id);
        if (!flight.current()) return; this.bind(result.current.actorId);
        this.emit({ submitting: false, pending: undefined, accepted: { kind: "draft", result }, detail: { state: "ready", value: { record: result.current, readiness: { state: "not_checked", issues: [] } } } });
        // Once a receipt is accepted, a failed refresh never changes that fact.
        await this.load("detail", result.current.id);
        if (pending.body.action === "create") await this.load("list");
      } else if (pending.kind === "runtime") {
        const result = await verifyRuntimeResult(raw, this.exactOwner(), pending.id, pending.body, pending.key);
        if (!flight.current()) return; this.bind(result.current.actorId);
        this.emit({ submitting: false, pending: undefined, accepted: { kind: "runtime", result } });
        await this.load("runtime", pending.id); await this.load("observations", pending.id); await this.load("notifications", pending.id);
      } else {
        const result = await verifyNotificationsResult(raw, this.exactOwner(), pending.id, pending.body, pending.key);
        if (!flight.current()) return; this.bind(result.current.actorId);
        this.emit({ submitting: false, pending: undefined, accepted: { kind: "notifications", result } });
        // Receipt acceptance is independent of the history read. This GET
        // never schedules, replays, or claims completion of a delivery.
        await this.load("notifications", pending.id);
      }
    } catch (error) {
      if (!flight.current()) return;
      const rejected = error instanceof ResponseError && error.status >= 400 && error.status < 500;
      const priorUncertainty = pending.kind === "notifications" && pending.uncertain;
      this.emit({ submitting: false, mutationError: `${rejected && priorUncertainty ? "Retry rejected; the earlier submitted request remains unconfirmed. Its frozen key is retained for receipt recovery. " : rejected ? "Request rejected. " : "Result unconfirmed. Retry the exact submitted request to recover its receipt. "}${error instanceof Error ? error.message : "Request unavailable."}`,
        ...(rejected && !priorUncertainty ? { pending: undefined } : pending.kind === "notifications" ? { pending: { ...pending, uncertain: true } } : {}) });
    }
  }
}
