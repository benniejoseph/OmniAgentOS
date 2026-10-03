import { createHash } from "node:crypto";
import {
  ACTIVITY_CONTRACT,
  ACTIVITY_GROUPS,
  ACTIVITY_SOURCE_LIMIT,
  type ActivityCoverage,
  type ActivityItem,
  type ActivityQuery,
  type ActivityResponse,
} from "@/lib/activity/contracts";
import { activityId, projectActivityApproval, projectActivityNotification, projectActivityRun } from "@/lib/activity/projection";
import type { ApprovalQueueItem } from "@/lib/operations/queue";
import type { AgentRunRecord } from "@/lib/runs/types";
import { canonicalActorIdFromExactRequestBinding, type CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import type { SecurityRole } from "@/lib/security/types";
import type { ThreadRecord } from "@/lib/threads/types";
import type { PersonalNotification } from "@/lib/today/types";

/** Constructed only from an authorized request; never accepted from query/body input. */
export type ActivityScope = {
  tenantId: string;
  actorId: string;
  role: SecurityRole;
  canReadApprovals: boolean;
  includeResponsibilityChanges?: boolean;
  requestActorBinding?: CanonicalRequestActorBindingV1;
};
type OwnerRead = { tenantId: string; actorId: string; requestActorBinding?: CanonicalRequestActorBindingV1 };
export type ActivityReadDependencies = {
  listRuns: (limit: number, scope: { tenantId: string }) => Promise<readonly AgentRunRecord[]>;
  getThread: (id: string, scope: OwnerRead) => Promise<Pick<ThreadRecord, "id" | "tenantId" | "actorId"> | null>;
  listApprovals: (limit: number, scope: { tenantId: string; actorId: string }) => Promise<{ items: readonly ApprovalQueueItem[] }>;
  listNotifications: (limit: number, scope: OwnerRead & { includeResponsibilityChanges?: boolean }) => Promise<readonly PersonalNotification[]>;
};

// Keep the broad store graphs outside pure projection tests and restricted reads.
const defaultReads: ActivityReadDependencies = {
  listRuns: async (limit, scope) => (await import("@/lib/runs/store")).listAgentRuns(limit, scope),
  getThread: async (id, scope) => (await import("@/lib/threads/store")).getOwnedThread(id, scope),
  listApprovals: async (limit, scope) => (await import("@/lib/operations/queue")).getApprovalQueue(limit, scope),
  listNotifications: async (limit, scope) => (await import("@/lib/today/notifications")).listNotifications(limit, scope),
};

export class ActivityRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly code: "activity_request_invalid" | "activity_cursor_stale",
  ) { super(message); this.name = "ActivityRequestError"; }
}

export function parseActivityQuery(url: URL): ActivityQuery {
  const group = url.searchParams.get("group") ?? "all";
  const limitValue = url.searchParams.get("limit") ?? "25";
  if ((group !== "all" && !ACTIVITY_GROUPS.some((value) => value === group)) ||
    !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitValue) ||
    ["group", "limit", "cursor"].some((key) => url.searchParams.getAll(key).length > 1)) throw invalidRequest();
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 2_000)) throw invalidRequest();
  return { group: group as ActivityQuery["group"], limit: Number(limitValue), ...(cursor ? { cursor } : {}) };
}

export async function getActivity(
  scope: ActivityScope,
  query: ActivityQuery,
  reads: ActivityReadDependencies = defaultReads,
): Promise<ActivityResponse> {
  if (typeof scope.tenantId !== "string" || !scope.tenantId || typeof scope.actorId !== "string" || !scope.actorId ||
    !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50 ||
    (query.group !== "all" && !ACTIVITY_GROUPS.includes(query.group))) throw invalidRequest();
  const canonicalActorId = canonicalActorIdFromExactRequestBinding(scope.actorId, scope.requestActorBinding);
  const owners = new Set([scope.actorId, ...(canonicalActorId ? [canonicalActorId] : [])]);
  const ownerRead: OwnerRead = {
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    ...(canonicalActorId ? { requestActorBinding: scope.requestActorBinding } : {}),
  };
  const scopeDigest = hash({ tenant: scope.tenantId, actor: scope.actorId, owners: [...owners].sort(), role: scope.role, approvals: scope.canReadApprovals,
    responsibilityChanges: scope.includeResponsibilityChanges !== false });
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (cursor && (cursor.scope !== scopeDigest || cursor.group !== query.group || cursor.limit !== query.limit)) throw staleCursor();

  const [runRead, approvalRead, notificationRead] = await Promise.allSettled([
    reads.listRuns(ACTIVITY_SOURCE_LIMIT, { tenantId: scope.tenantId }),
    scope.canReadApprovals
      ? reads.listApprovals(ACTIVITY_SOURCE_LIMIT, { tenantId: scope.tenantId, actorId: scope.actorId })
      : Promise.resolve(undefined),
    reads.listNotifications(ACTIVITY_SOURCE_LIMIT, {
      ...ownerRead,
      ...(scope.includeResponsibilityChanges === false ? { includeResponsibilityChanges: false } : {}),
    }),
  ]);
  const coverage: ActivityResponse["coverage"] = {
    runs: failedCoverage(),
    approvals: scope.canReadApprovals ? failedCoverage() : { state: "restricted", limit: ACTIVITY_SOURCE_LIMIT, visibleCount: null, reason: "permission_required" },
    notifications: failedCoverage(),
  };

  const readableRuns: AgentRunRecord[] = [];
  let omittedRuns = false;
  if (runRead.status === "fulfilled" && Array.isArray(runRead.value)) {
    const candidates = runRead.value.slice(0, ACTIVITY_SOURCE_LIMIT).filter((run) => {
      const owned = Boolean(run && run.tenantId === scope.tenantId && owners.has(run.ownerActorId));
      if (!owned) omittedRuns = true;
      return owned;
    });
    const threadReads = new Map<string, Promise<boolean>>();
    const canReadThread = (id: string) => {
      let result = threadReads.get(id);
      if (!result) {
        result = reads.getThread(id, ownerRead).then((thread) => Boolean(thread &&
          thread.id === id && thread.tenantId === scope.tenantId && thread.actorId === scope.actorId));
        threadReads.set(id, result);
      }
      return result;
    };
    // Bound source checks and never project even a summary before ownership is known.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const checked = await Promise.all(candidates.slice(offset, offset + 4).map(async (run) => {
        try { return !run.threadId || await canReadThread(run.threadId) ? run : undefined; }
        catch { return undefined; }
      }));
      for (const run of checked) {
        if (run) readableRuns.push(run);
        else omittedRuns = true;
      }
    }
    coverage.runs = readyCoverage(0, omittedRuns);
  }
  const runEntries = uniqueProjection(readableRuns, projectActivityRun, pendingApprovalId);
  if (coverage.runs.state !== "unavailable") coverage.runs = readyCoverage(runEntries.entries.length, omittedRuns || runEntries.omitted);
  const waitingRuns = new Map<string, AgentRunRecord>();
  const ambiguousApprovals = new Set<string>();
  for (const { record } of runEntries.entries) {
    const id = record.status === "waiting_approval" ? pendingApprovalId(record) : undefined;
    if (!id) continue;
    if (waitingRuns.has(id)) ambiguousApprovals.add(id);
    else waitingRuns.set(id, record);
  }
  for (const id of ambiguousApprovals) waitingRuns.delete(id);

  let approvalItems: ActivityItem[] = [];
  if (scope.canReadApprovals && approvalRead.status === "fulfilled" && Array.isArray(approvalRead.value?.items)) {
    let omitted = false;
    const records = approvalRead.value.items.slice(0, ACTIVITY_SOURCE_LIMIT).filter((item) => {
      const permitted = Boolean(item && item.tenantId === scope.tenantId && item.record?.tenantId === scope.tenantId);
      if (!permitted) omitted = true;
      return permitted;
    });
    const projected = uniqueProjection(records, (item) => projectActivityApproval(item, item.kind === "tool" ? waitingRuns.get(item.id) : undefined));
    approvalItems = projected.entries.map(({ item }) => item);
    coverage.approvals = readyCoverage(approvalItems.length, omitted || projected.omitted);
  }
  let notificationItems: ActivityItem[] = [];
  if (notificationRead.status === "fulfilled" && Array.isArray(notificationRead.value)) {
    let omitted = false;
    const records = notificationRead.value.slice(0, ACTIVITY_SOURCE_LIMIT).filter((item) => {
      if (scope.includeResponsibilityChanges === false && item?.kind === "responsibility_change") return false;
      const owned = Boolean(item && item.tenantId === scope.tenantId && owners.has(item.actorId));
      if (!owned) omitted = true;
      return owned;
    });
    const projected = uniqueProjection(records, projectActivityNotification);
    notificationItems = projected.entries.map(({ item }) => item);
    coverage.notifications = readyCoverage(notificationItems.length, omitted || projected.omitted);
  }
  const foldedRuns = new Set(approvalItems.flatMap((item) => item.origin ? [item.origin.runId] : []));
  const items = [
    ...runEntries.entries.filter(({ record }) => !foldedRuns.has(record.id)).map(({ item }) => item),
    ...approvalItems,
    ...notificationItems,
  ].sort((left, right) => right.timestamp.at.localeCompare(left.timestamp.at) ||
    (left.workKey < right.workKey ? -1 : left.workKey > right.workKey ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const windowDigest = hash({ items, coverage });
  if (cursor && cursor.window !== windowDigest) throw staleCursor();
  const filtered = query.group === "all" ? items : items.filter((item) => item.group === query.group);
  const offset = cursor?.offset ?? 0;
  if (cursor && offset >= filtered.length) throw staleCursor();
  const pageItems = filtered.slice(offset, offset + query.limit);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < filtered.length;
  const states = Object.values(coverage).map((source) => source.state);
  return {
    schemaVersion: 1,
    contract: ACTIVITY_CONTRACT,
    generatedAt: new Date().toISOString(),
    state: states.every((state) => state === "unavailable" || state === "restricted") ? "unavailable"
      : states.every((state) => state === "ready") ? "ready" : "partial",
    group: query.group,
    items: pageItems,
    counts: {
      working: items.filter((item) => item.group === "working").length,
      needs_you: items.filter((item) => item.group === "needs_you").length,
      updates: items.filter((item) => item.group === "updates").length,
      history: items.filter((item) => item.group === "history").length,
    },
    coverage,
    window: { bounded: true, limitPerSource: ACTIVITY_SOURCE_LIMIT },
    page: { limit: query.limit, hasMore, nextCursor: hasMore ? encodeCursor({ version: 1, scope: scopeDigest, window: windowDigest, group: query.group, limit: query.limit, offset: nextOffset }) : null },
  };
}

function pendingApprovalId(run: AgentRunRecord) {
  const id = run.continuation?.pendingToolCall?.executionId;
  return activityId(id) ? id : undefined;
}

function uniqueProjection<T>(records: readonly T[], project: (record: T) => ActivityItem | undefined, binding?: (record: T) => unknown) {
  const entries = new Map<string, { record: T; item: ActivityItem; digest: string }>();
  const conflicts = new Set<string>();
  let omitted = false;
  for (const record of records) {
    const item = project(record);
    if (!item) { omitted = true; continue; }
    const digest = hash({ item, binding: binding?.(record) });
    const previous = entries.get(item.id);
    if (previous && previous.digest !== digest) { conflicts.add(item.id); omitted = true; }
    else if (!previous) entries.set(item.id, { record, item, digest });
  }
  return { entries: [...entries.values()].filter(({ item }) => !conflicts.has(item.id)), omitted };
}

function readyCoverage(visibleCount: number, partial: boolean): ActivityCoverage {
  return { state: partial ? "partial" : "ready", limit: ACTIVITY_SOURCE_LIMIT, visibleCount, ...(partial ? { reason: "records_omitted" as const } : {}) };
}
function failedCoverage(): ActivityCoverage { return { state: "unavailable", limit: ACTIVITY_SOURCE_LIMIT, visibleCount: null, reason: "read_failed" }; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
type Cursor = { version: 1; scope: string; window: string; group: ActivityQuery["group"]; limit: number; offset: number };
function encodeCursor(value: Cursor) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidRequest();
    const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join(",") !== "group,limit,offset,scope,version,window" ||
      data.version !== 1 || typeof data.scope !== "string" || typeof data.window !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.scope) || !/^[a-f0-9]{64}$/.test(data.window) ||
      (data.group !== "all" && !ACTIVITY_GROUPS.includes(data.group)) ||
      !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 50 ||
      !Number.isInteger(data.offset) || data.offset < data.limit || data.offset > 300 || data.offset % data.limit !== 0) throw invalidRequest();
    return data;
  } catch { throw invalidRequest(); }
}
function invalidRequest() { return new ActivityRequestError("Activity parameters are invalid. Reload the first page.", 400, "activity_request_invalid"); }
function staleCursor() { return new ActivityRequestError("Activity changed or access was updated. Reload the first page.", 409, "activity_cursor_stale"); }
