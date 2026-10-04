import {
  INBOX_CHANGED_EVENT,
  parseApprovalKind,
  type ApprovalKind,
} from "@/lib/approvals/inbox-link";

/** The page the inbox reads, and each further page it shows. */
export const APPROVAL_PAGE_SIZE = 25;
/** The most items one request to the queue may return. */
const MAX_APPROVAL_REQUEST_LIMIT = 100;
/** The most items a refresh reads again, however far the inbox was paged. */
export const MAX_REFRESHED_APPROVALS = 200;
const MAX_QUEUE_REQUESTS = 4;

export type JsonRecord = Record<string, unknown>;

export type ApprovalItem = {
  kind: ApprovalKind;
  id: string;
  title: string;
  status: string;
  riskLevel: number;
  /** What a tool item's contract says its effect is; see the queue. */
  contract?: { reversible: boolean; readOnly: boolean; effect?: string };
  requestedBy?: string;
  reason?: string;
  createdAt: string;
  input?: JsonRecord;
  record?: {
    toolId?: string;
    approvals?: Array<{ by?: string; actorId?: string; role?: string }>;
    approvalPolicy?: { quorum?: number };
  };
  /** The run paused on this item, shown only to that run's owner. */
  origin?: { runId: string; threadId?: string };
};

export type ApprovalQueueStats = {
  total: number;
  tools: number;
  reconciliations: number;
  workflows: number;
  sloPolicies: number;
};

export type ApprovalQueuePage = {
  items: ApprovalItem[];
  stats: ApprovalQueueStats;
  nextCursor: string | null;
};

export type TrustProfile = {
  toolId: string;
  cleanStreak: number;
  successes: number;
  failures: number;
  autonomyMode: "approve_each" | "auto_with_alert";
  reversible: boolean;
  autonomy?: {
    stage: "manual" | "shadow" | "supervised" | "autonomous";
    progress: number;
    score: number;
    confidence: number;
    freshness: number;
    reason: string;
    budget: { maxActions: number; windowSeconds: number };
  };
};

export type TrustResponse = {
  enabled: boolean;
  authorityMode?: "bounded_grants";
  threshold: number;
  profiles: TrustProfile[];
};

export type ApprovalDecision = "approve" | "reject";

export type ApprovalDecisionForm = {
  reason?: string;
  breakGlass?: boolean;
  ticket?: string;
};

export type DecisionNotice = {
  message: string;
  tone: "success" | "warning" | "danger" | "neutral";
};

export function isReconciliationItem(item: Pick<ApprovalItem, "kind" | "status" | "record">) {
  return item.kind === "tool" &&
    item.status === "reconciliation_required" &&
    item.record?.toolId === "memory.forget";
}

export function approvalItemKey(item: Pick<ApprovalItem, "kind" | "id">) {
  return `${item.kind}:${item.id}`;
}

/** The id of the heading of the card with this key. */
export function approvalHeadingId(key: string) {
  return `approval-heading-${key}`;
}

/**
 * Where focus goes once a decision is read back, so it is not lost with the
 * card it was on: the decided card while it is still listed, else the card
 * now in its place or the last one, else the heading of the list.
 */
export function headingAfterDecision(
  decided: { key: string; index: number },
  shownKeys: readonly string[],
  listHeadingId: string,
) {
  const key = shownKeys.includes(decided.key)
    ? decided.key
    : shownKeys[Math.min(decided.index, shownKeys.length - 1)];
  return key === undefined ? listHeadingId : approvalHeadingId(key);
}

/**
 * Moves focus to the heading headingAfterDecision names, unless the approver
 * has already moved it somewhere on the page.
 */
export function focusAfterDecision(
  page: Pick<Document, "activeElement" | "body" | "getElementById">,
  decided: { key: string; index: number },
  shownKeys: readonly string[],
  listHeadingId: string,
) {
  const active = page.activeElement;
  if (active && active !== page.body) {
    return;
  }
  page.getElementById(headingAfterDecision(decided, shownKeys, listHeadingId))?.focus();
}

/** The body of a decision. A reconciliation carries no note of its own. */
export function approvalDecisionRequest(
  item: ApprovalItem,
  decision: ApprovalDecision,
  form: ApprovalDecisionForm = {},
) {
  const sloApproval = item.kind === "slo_policy" && decision === "approve";
  return {
    kind: item.kind,
    decision,
    reason: isReconciliationItem(item) ? undefined : form.reason || undefined,
    breakGlass: sloApproval ? Boolean(form.breakGlass) : undefined,
    ticket: sloApproval ? form.ticket || undefined : undefined,
  };
}

/** What to tell the approver once the server has answered a decision. */
export function approvalDecisionNotice(
  item: ApprovalItem,
  decision: ApprovalDecision,
  status: number,
  body: JsonRecord,
): DecisionNotice {
  const reconciliationRequired = isReconciliationItem(item);
  const continuation = body.continuation as { scheduled?: boolean } | undefined;
  const quorum = body.quorum as { message?: string } | undefined;
  const approvalProgress = body.approvalProgress as
    | { approvals?: number; required?: number; remaining?: number }
    | undefined;
  const executionRecord = body.record as
    | { status?: string; reason?: string }
    | undefined;
  const resumeNote =
    decision === "approve" && continuation?.scheduled
      ? " The paused agent run is resuming in the background. Its final answer will appear in Results."
      : "";
  const stillPending =
    decision === "approve" &&
    (status === 202 || Boolean(approvalProgress?.remaining));
  if (executionRecord?.status === "failed" || executionRecord?.status === "blocked") {
    return {
      message: `${reconciliationRequired ? "Reconciliation finished" : "Approval recorded"} for ${item.title}, but execution ${executionRecord.status === "blocked" ? "was blocked" : "failed"}${
        executionRecord.reason ? `: ${executionRecord.reason}` : "."
      }${resumeNote}`,
      tone: "danger",
    };
  }
  if (executionRecord?.status === "executing") return { message: `Approval recorded for ${item.title}. Execution is still in progress; its outcome is not confirmed.${resumeNote}`, tone: "warning" };
  if (executionRecord?.status === "dry_run") return { message: `Approval recorded for ${item.title}. The dry run completed; it does not prove a live effect.`, tone: "neutral" };
  if (reconciliationRequired) {
    return stillPending
      ? { message: `Reconciliation is in progress for ${item.title}.${resumeNote}`, tone: "warning" }
      : { message: `Reconciled and continued: ${item.title}.${resumeNote}`, tone: "success" };
  }
  if (stillPending) {
    return {
      message: `Approval recorded for ${item.title}. ${
        quorum?.message ||
        `${approvalProgress?.approvals || 0}/${approvalProgress?.required || 1} required approvals are recorded.`
      }`,
      tone: "warning",
    };
  }
  return {
    message: `${decision === "approve" ? "Approved and released" : "Rejected"}: ${item.title}.${resumeNote}`,
    tone: "success",
  };
}

/**
 * The Idempotency-Key of each decision sent and not yet answered. Sending
 * the same decision again, after the answer was lost or the server failed,
 * reuses its key. A changed decision or note cannot replace an unknown request.
 */
export type ApprovalDecisionAuthority = { scope: string; isCurrent: () => boolean };
export type ApprovalDecisionRequest = { kind: string; decision: ApprovalDecision; reason?: string; breakGlass?: boolean; ticket?: string };
export class ApprovalDecisionUnconfirmedError extends Error {
  constructor(public readonly request: Readonly<ApprovalDecisionRequest>, message = "The decision outcome is unconfirmed. Recover only the same saved decision; no approval was repeated automatically.") {
    super(message);
    this.name = "ApprovalDecisionUnconfirmedError";
  }
}
const unansweredDecisionKeys = new Map<string, { key: string; body: string; request: Readonly<ApprovalDecisionRequest>; busy: boolean }>();
const recordValue = (value: unknown): JsonRecord | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const validCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A 2xx alone is not evidence of the exact decision or its execution. */
export function validateApprovalDecisionResponse(id: string, request: ApprovalDecisionRequest, status: number, value: unknown): JsonRecord {
  const body = recordValue(value);
  const invalid = () => { throw new ApprovalDecisionUnconfirmedError(request, "The decision response did not prove the exact item and outcome. The original decision is retained for recovery."); };
  if (!body || ![200, 202].includes(status) || body.error !== undefined) return invalid();
  const continuation = recordValue(body.continuation);
  if (body.continuation !== undefined && (!continuation || typeof continuation.scheduled !== "boolean")) return invalid();
  const progress = recordValue(body.approvalProgress);
  if (body.approvalProgress !== undefined && (!progress || !validCount(progress.approvals) || !validCount(progress.required) || !validCount(progress.remaining) || Number(progress.required) < 1 || Number(progress.approvals) > Number(progress.required) || Number(progress.remaining) > Number(progress.required))) return invalid();
  if (request.kind === "tool") {
    const record = recordValue(body.record);
    if (!record || record.id !== id || typeof record.toolId !== "string" || !record.toolId) return invalid();
    if (status === 202) {
      const quorum = recordValue(body.quorum);
      if (request.decision !== "approve" || record.status !== "approval_required" || !quorum || !validCount(quorum.have) || !validCount(quorum.need) || Number(quorum.have) < 1 || Number(quorum.need) <= Number(quorum.have)) return invalid();
    } else if (record.approvalDecision !== (request.decision === "approve" ? "approved" : "rejected") ||
      !(request.decision === "reject" ? ["rejected"] : ["executed", "executing", "dry_run", "failed", "blocked"]).includes(String(record.status))) return invalid();
  } else if (request.kind === "workflow") {
    const run = recordValue(body.run);
    if (status !== 200 || !run || run.id !== id ||
      (request.decision === "reject" ? run.status !== "canceled" : !["queued", "running", "paused", "completed", "failed"].includes(String(run.status)) || typeof run.approvedAt !== "string" || !Number.isFinite(Date.parse(run.approvedAt)))) return invalid();
  } else if (request.kind === "slo_policy") {
    const change = recordValue(body.change);
    if (!change || change.id !== id || change.status !== (request.decision === "reject" ? "rejected" : status === 202 ? "pending" : "applied") || (request.decision === "reject" && status !== 200)) return invalid();
    if (status === 202 && (!progress || Number(progress.approvals) < 1 || Number(progress.remaining) < 1 || progress.canApply !== false)) return invalid();
  } else return invalid();
  return body;
}

/** Posts one decision on an item under its Idempotency-Key. */
export async function postApprovalDecision(
  id: string,
  request: ApprovalDecisionRequest,
  fetchImpl: typeof fetch = fetch,
  authority?: ApprovalDecisionAuthority,
) {
  if (authority && !authority.isCurrent()) throw new Error("Account access changed. Review the approval again.");
  const body = JSON.stringify(request);
  const sent = `${authority?.scope || "unbound"}\u0000${request.kind}\u0000${id}`;
  const existing = unansweredDecisionKeys.get(sent);
  if (existing && (existing.body !== body || existing.busy)) throw new ApprovalDecisionUnconfirmedError(existing.request, "A decision is already pending for this exact item. Retry the original saved decision after the active request finishes.");
  if (!existing && unansweredDecisionKeys.size >= 64) throw new Error("Resolve pending decisions before submitting another approval.");
  const pending = existing ?? { key: `approval-${request.decision}-${crypto.randomUUID()}`, body,
    request: Object.freeze({ ...request }), busy: false };
  pending.busy = true;
  unansweredDecisionKeys.set(sent, pending);
  try {
    const response = await fetchImpl(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": pending.key }, body: pending.body,
    });
    if (authority && !authority.isCurrent()) throw new ApprovalDecisionUnconfirmedError(pending.request);
    if (response.ok) {
      const result: unknown = await response.clone().json().catch(() => undefined);
      validateApprovalDecisionResponse(id, request, response.status, result);
      if (authority && !authority.isCurrent()) throw new ApprovalDecisionUnconfirmedError(pending.request);
      unansweredDecisionKeys.delete(sent);
    } else if (!existing && [400, 401, 403, 404, 409, 413, 415, 422].includes(response.status)) {
      unansweredDecisionKeys.delete(sent);
    } else {
      throw new ApprovalDecisionUnconfirmedError(pending.request);
    }
    return response;
  } catch (error) {
    if (error instanceof ApprovalDecisionUnconfirmedError) throw error;
    throw new ApprovalDecisionUnconfirmedError(pending.request);
  } finally {
    pending.busy = false;
  }
}

/** Sends one decision and returns the notice for it, or throws the server's reason. */
export async function submitApprovalDecision(
  item: ApprovalItem,
  decision: ApprovalDecision,
  form: ApprovalDecisionForm = {},
  fetchImpl: typeof fetch = fetch,
  authority?: ApprovalDecisionAuthority,
) {
  const response = await postApprovalDecision(
    item.id,
    approvalDecisionRequest(item, decision, form),
    fetchImpl,
    authority,
  );
  const body = (await response.json().catch(() => ({}))) as JsonRecord;
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `Decision failed (${response.status}).`));
  }
  return approvalDecisionNotice(item, decision, response.status, body);
}

/**
 * Adds a later page to the pages already shown. An item can move up while
 * the list is read page by page, so one already shown is not shown twice.
 */
export function appendApprovalPage(
  shown: ApprovalItem[],
  page: ApprovalItem[],
) {
  const seen = new Set(shown.map(approvalItemKey));
  return [
    ...shown,
    ...page.filter((item) => {
      const key = approvalItemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export function readApprovalItem(value: unknown): ApprovalItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Partial<ApprovalItem>;
  return typeof item.id === "string" && item.id && parseApprovalKind(item.kind)
    ? (value as ApprovalItem)
    : undefined;
}

export function readApprovalQueuePage(value: unknown): ApprovalQueuePage {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
  const stats = record.stats && typeof record.stats === "object"
    ? (record.stats as Partial<ApprovalQueueStats>)
    : {};
  return {
    items: Array.isArray(record.items)
      ? record.items.flatMap((item) => readApprovalItem(item) ?? [])
      : [],
    stats: {
      total: Number(stats.total) || 0,
      tools: Number(stats.tools) || 0,
      reconciliations: Number(stats.reconciliations) || 0,
      workflows: Number(stats.workflows) || 0,
      sloPolicies: Number(stats.sloPolicies) || 0,
    },
    nextCursor: typeof record.nextCursor === "string" && record.nextCursor
      ? record.nextCursor
      : null,
  };
}

export async function fetchApprovalQueuePage(
  { limit = APPROVAL_PAGE_SIZE, cursor }: { limit?: number; cursor?: string | null } = {},
  fetchImpl: typeof fetch = fetch,
) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  const response = await fetchImpl(`/api/approvals?${params}`, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as JsonRecord;
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `Approvals returned ${response.status}`));
  }
  return readApprovalQueuePage(body);
}

/**
 * Reads the queue from the top until `limit` items are shown. Reading it
 * again from the top, rather than keeping pages read earlier, drops the
 * items decided since and places new ones where they rank.
 */
export async function loadApprovalQueue(
  limit: number,
  fetchPage: (request: { limit: number; cursor?: string | null }) => Promise<ApprovalQueuePage> =
    (request) => fetchApprovalQueuePage(request),
): Promise<ApprovalQueuePage> {
  const wanted = Math.max(
    1,
    Math.min(MAX_REFRESHED_APPROVALS, Math.trunc(limit) || APPROVAL_PAGE_SIZE),
  );
  const first = await fetchPage({ limit: Math.min(MAX_APPROVAL_REQUEST_LIMIT, wanted) });
  let items = first.items;
  let nextCursor = first.nextCursor;
  for (
    let requests = 1;
    nextCursor && items.length < wanted && requests < MAX_QUEUE_REQUESTS;
    requests += 1
  ) {
    const page = await fetchPage({
      limit: Math.min(MAX_APPROVAL_REQUEST_LIMIT, wanted - items.length),
      cursor: nextCursor,
    });
    items = appendApprovalPage(items, page.items);
    nextCursor = page.nextCursor;
  }
  // Every page counts the whole queue; the first one is read with the list.
  return { items, stats: first.stats, nextCursor };
}

export type ApprovalFocus = { id: string; kind?: ApprovalKind };

export async function fetchApprovalQueueItem(
  { id, kind }: ApprovalFocus,
  fetchImpl: typeof fetch = fetch,
) {
  const params = new URLSearchParams({ id });
  if (kind) {
    params.set("kind", kind);
  }
  const response = await fetchImpl(`/api/approvals?${params}`, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as JsonRecord;
  if (!response.ok) {
    throw new Error(String(
      body.message || body.error || `The approval could not be loaded (${response.status}).`,
    ));
  }
  if (body.item === null) return undefined;
  const item = readApprovalItem(body.item);
  if (!item || !matchesApprovalFocus(item, { id, kind })) throw new Error("The approval response did not match the requested item.");
  return item;
}

export function matchesApprovalFocus(item: ApprovalItem, focus: ApprovalFocus) {
  return item.id === focus.id && (!focus.kind || item.kind === focus.kind);
}

export type FocusedApproval =
  | { status: "ready"; item: ApprovalItem }
  | { status: "missing" };

/**
 * Finds the item a link opened the inbox on. The loaded queue answers when
 * it shows the item or holds every pending item; otherwise the item is read
 * by its id.
 */
export async function findFocusedApproval(
  queue: ApprovalQueuePage,
  focus: ApprovalFocus,
  fetchItem: (focus: ApprovalFocus) => Promise<ApprovalItem | undefined> =
    (value) => fetchApprovalQueueItem(value),
): Promise<FocusedApproval> {
  const shown = queue.items.find((item) => matchesApprovalFocus(item, focus));
  if (shown) {
    return { status: "ready", item: shown };
  }
  if (!queue.nextCursor) {
    return { status: "missing" };
  }
  const item = await fetchItem(focus);
  return item && matchesApprovalFocus(item, focus)
    ? { status: "ready", item }
    : { status: "missing" };
}

/**
 * Where to send the approver after a decision: back where they came from,
 * once the item a link opened went through. A failure or a missing quorum
 * stays in the inbox, where the notice explains it.
 */
export function approvalReturnPath(
  item: ApprovalItem,
  notice: DecisionNotice,
  focus: ApprovalFocus | undefined,
  returnTo: string | undefined,
) {
  return returnTo &&
    focus &&
    matchesApprovalFocus(item, focus) &&
    notice.tone === "success"
    ? returnTo
    : undefined;
}

/**
 * Decides an item shown outside the inbox, then reads it again: an approval
 * that still needs another approver stays pending and shows who approved.
 */
export async function decideAndReread(
  item: ApprovalItem,
  decision: ApprovalDecision,
  form: ApprovalDecisionForm = {},
  fetchImpl: typeof fetch = fetch,
  authority?: ApprovalDecisionAuthority,
) {
  const notice = await submitApprovalDecision(item, decision, form, fetchImpl, authority);
  if (authority && !authority.isCurrent()) return { notice, item: undefined };
  announceInboxChanged();
  const pending = await fetchApprovalQueueItem({ id: item.id, kind: item.kind }, fetchImpl)
    .catch(() => undefined);
  return { notice, item: pending };
}

/** Tells the navigation badge to count the inbox again. */
export function announceInboxChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
  }
}
