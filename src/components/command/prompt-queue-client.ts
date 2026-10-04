import type { PromptQueueItemV1 } from "@/lib/command/prompt-queue-contracts";

export type PromptQueueItem = PromptQueueItemV1 & {
  contextReferenceCount: number;
  model: PromptQueueItemV1["model"] & { reasoningLevel?: string };
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: ObjectValue, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max = 240): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const id = (value: unknown) => text(value) && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const oneOf = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value);
const nullable = (value: unknown, accepts: (value: unknown) => boolean) => value === null || accepts(value);
const providers = ["openai", "google", "anthropic", "aws_bedrock"];
const invalid = () => new Error("The queue response is invalid. The last confirmed queue remains visible.");
const sameValue = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (object(left) && object(right)) return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && sameValue(value, right[key]));
  return left === right;
};

function validReference(value: unknown) {
  return object(value) && keys(value, ["kind", "id"], ["expectedVersion", "versionId", "bindingSha256"]) &&
    oneOf(value.kind, ["agent", "skill", "plugin", "project", "integration", "file"]) &&
    text(value.id, 320) && /^[A-Za-z0-9_.:@/+~=-]+$/.test(value.id) &&
    (value.expectedVersion === undefined || integer(value.expectedVersion, 1)) &&
    (value.versionId === undefined || text(value.versionId, 320)) &&
    (value.bindingSha256 === undefined || digest(value.bindingSha256)) &&
    (value.kind !== "file" || (text(value.versionId, 320) && digest(value.bindingSha256)));
}

/** Browser-only validation: the authoritative schema imports Node crypto. */
export function readPromptQueueItem(value: unknown): PromptQueueItem {
  if (!object(value) || !keys(value, ["schemaVersion", "id", "clientCorrelationId", "originSessionId", "lastModifiedSessionId", "prompt", "promptSha256", "mode", "strategy", "target", "targetSha256", "agent", "model", "context", "state", "position", "lifecycleRevision", "runId", "resultThreadId", "progressLabel", "failureCode", "createdAt", "updatedAt", "dispatchedAt", "terminalAt", "queueGrantsAuthority"])) throw invalid();
  const { target, agent, model, context } = value;
  if (value.schemaVersion !== 1 || value.queueGrantsAuthority !== false || !uuid(value.id) ||
    !id(value.clientCorrelationId) || !id(value.originSessionId) || !id(value.lastModifiedSessionId) ||
    typeof value.prompt !== "string" || !value.prompt.length || value.prompt.length > 20_000 || !digest(value.promptSha256) || !digest(value.targetSha256) ||
    !oneOf(value.mode, ["orchestrate", "research", "execute", "learn"]) || !oneOf(value.strategy, ["direct", "auto"]) ||
    !oneOf(value.state, ["queued", "paused", "dispatching", "completed", "failed"]) || !integer(value.position, 1) || !integer(value.lifecycleRevision) ||
    !nullable(value.runId, id) || !nullable(value.resultThreadId, id) || !nullable(value.failureCode, id) ||
    !nullable(value.progressLabel, (entry) => text(entry, 160)) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !nullable(value.dispatchedAt, timestamp) || !nullable(value.terminalAt, timestamp)) throw invalid();
  if (!object(target) || !keys(target, ["threadId", "missionId", "projectId", "executionTarget"]) ||
    !nullable(target.threadId, uuid) || !nullable(target.missionId, uuid) ||
    !nullable(target.projectId, (entry) => text(entry, 200) && /^[A-Za-z0-9_.:-]+$/.test(entry)) ||
    !oneOf(target.executionTarget, ["asael", "local_macos"])) throw invalid();
  if (!object(agent) || !keys(agent, ["logicalAgentId", "definitionId", "definitionVersion", "definitionVersionId", "definitionSha256", "principalId", "principalGeneration", "principalVersionId", "principalSha256"]) ||
    ![agent.logicalAgentId, agent.definitionId, agent.definitionVersionId, agent.principalId, agent.principalVersionId].every(id) ||
    !integer(agent.definitionVersion, 1) || !integer(agent.principalGeneration, 1) || !digest(agent.definitionSha256) || !digest(agent.principalSha256)) throw invalid();
  if (!object(model) || !keys(model, ["providerId", "modelId", "tier", "assignmentId", "assignmentRevision", "assignmentConfigurationSha256", "routingPolicySha256"], ["commandSelection", "commandSelectionSha256"]) ||
    !oneOf(model.providerId, providers) || !id(model.modelId) || !oneOf(model.tier, ["fast", "reasoning"]) ||
    !nullable(model.assignmentId, id) || !nullable(model.assignmentRevision, (entry) => integer(entry, 1)) || !nullable(model.assignmentConfigurationSha256, digest) || !digest(model.routingPolicySha256) ||
    ![model.assignmentId, model.assignmentRevision, model.assignmentConfigurationSha256].every((entry) => (entry === null) === (model.assignmentId === null))) throw invalid();
  const selection = model.commandSelection;
  if (selection !== undefined && selection !== null && (!object(selection) ||
    !keys(selection, ["schemaVersion", "assignmentId", "assignmentRevision", "assignmentConfigurationSha256", "route", "provider", "modelId"], ["reasoningLevel"]) ||
    selection.schemaVersion !== 1 || !text(selection.assignmentId) || !integer(selection.assignmentRevision, 1) || !digest(selection.assignmentConfigurationSha256) ||
    !oneOf(selection.route, ["primary", "fallback"]) || !oneOf(selection.provider, providers) || !text(selection.modelId) ||
    (selection.reasoningLevel !== undefined && !oneOf(selection.reasoningLevel, ["low", "medium", "high", "extra_high", "ultra"])))) throw invalid();
  if ((model.commandSelectionSha256 !== undefined && !nullable(model.commandSelectionSha256, digest)) || Boolean(selection) !== Boolean(model.commandSelectionSha256)) throw invalid();
  if (context !== null && (!object(context) || !keys(context, ["schemaVersion", "references", "selectionSha256", "contextBlockSha256", "receiptSha256"]) ||
    context.schemaVersion !== 1 || !digest(context.selectionSha256) || !digest(context.contextBlockSha256) || !digest(context.receiptSha256) ||
    !Array.isArray(context.references) || !context.references.length || context.references.length > 20 || !context.references.every(validReference) ||
    new Set(context.references.map((reference) => `${reference.kind}:${reference.id}`)).size !== context.references.length)) throw invalid();
  const item = value as unknown as PromptQueueItemV1;
  return { ...item, contextReferenceCount: item.context?.references.length ?? 0,
    model: { ...item.model, reasoningLevel: item.model.commandSelection?.reasoningLevel } };
}

export function readPromptQueueItems(value: unknown, list = true): PromptQueueItem[] {
  if (!object(value) || !keys(value, list ? ["schemaVersion", "items", "serverTime"] : ["items"]) ||
    (list && (value.schemaVersion !== 1 || !timestamp(value.serverTime))) || !Array.isArray(value.items) || value.items.length > 40) throw invalid();
  const items = value.items.map(readPromptQueueItem);
  if (new Set(items.map((item) => item.id)).size !== items.length || new Set(items.map((item) => item.clientCorrelationId)).size !== items.length) throw invalid();
  return items;
}

export type QueueIntent = Readonly<{ operation: "create" | "update" | "delete" | "reorder"; id: string; url: string; method: string; body: string }>;
export function readQueueWriteResult(intent: QueueIntent, value: unknown): PromptQueueItem[] {
  if (!object(value)) throw invalid();
  const request = JSON.parse(intent.body) as ObjectValue;
  if (intent.operation === "delete") {
    if (!keys(value, ["deleted", "id"]) || value.deleted !== true || value.id !== intent.id) throw invalid();
    return [];
  }
  if (intent.operation === "reorder") {
    const items = readPromptQueueItems(value, false);
    const expected = request.items as Array<{ id: string; expectedRevision: number }>;
    if (items.length !== expected.length || items.some((item, index) => item.id !== expected[index].id || item.lifecycleRevision !== expected[index].expectedRevision + 1 || item.position !== (index + 1) * 1024)) throw invalid();
    return items;
  }
  if (!keys(value, intent.operation === "create" ? ["item", "created"] : ["item"])) throw invalid();
  const item = readPromptQueueItem(value.item);
  if (intent.operation === "create") {
    const target = request.target as ObjectValue;
    if (typeof value.created !== "boolean" || item.clientCorrelationId !== intent.id || item.prompt !== request.prompt || item.mode !== request.mode || item.strategy !== request.strategy || item.agent.logicalAgentId !== request.agentId ||
      !sameValue(item.context?.references ?? [], request.contextReferences ?? []) || !sameValue(item.model.commandSelection ?? null, request.modelSelection ?? null) ||
      Object.entries(target).some(([key, field]) => item.target[key as keyof typeof item.target] !== field)) throw invalid();
  } else if (item.id !== intent.id || item.lifecycleRevision !== Number(request.expectedRevision) + 1 ||
    (request.prompt !== undefined && item.prompt !== request.prompt) || (request.state !== undefined && item.state !== request.state)) throw invalid();
  return [item];
}
/** One admitted write. Unknown writes never mint another correlation or CAS. */
export class PromptQueueMutationSlot {
  pending?: QueueIntent;
  busy = false;
  begin(intent: QueueIntent) {
    if (this.busy || this.pending) throw new Error("Review the unconfirmed queue change before making another change.");
    this.pending = Object.freeze({ ...intent });
    this.busy = true;
    return this.pending;
  }
  retry() {
    if (this.busy || !this.pending || this.pending.operation !== "create") throw new Error("Refresh and review the current queue before making another change.");
    this.busy = true;
    return this.pending;
  }
  settle() { this.busy = false; this.pending = undefined; }
  uncertain() { this.busy = false; }
  reviewed() {
    // Create must retain its correlation until an exact server acknowledgment.
    if (!this.busy && this.pending?.operation !== "create") this.pending = undefined;
  }
}

// Navigation in the same browser document must not discard an unresolved key.
// This bounded memory journal is partitioned by canonical owner, role and origin.
const ownerQueueMutations = new Map<string, PromptQueueMutationSlot>();
export function promptQueueMutationsForOwner(owner: string) {
  const existing = ownerQueueMutations.get(owner);
  if (existing) return existing;
  if (ownerQueueMutations.size >= 16) {
    const settled = [...ownerQueueMutations].find(([, slot]) => !slot.pending && !slot.busy);
    if (settled) ownerQueueMutations.delete(settled[0]);
    else throw new Error("Too many accounts have unconfirmed queue changes in this window. Recover an existing change first.");
  }
  const slot = new PromptQueueMutationSlot();
  ownerQueueMutations.set(owner, slot);
  return slot;
}
