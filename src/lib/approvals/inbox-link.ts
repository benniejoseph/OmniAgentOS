/**
 * Links into and out of the approvals inbox. The browser and the server both
 * use these, so they rely only on the URL API.
 */

export const APPROVAL_KINDS = ["tool", "workflow", "slo_policy"] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Fired on `window` after a decision that may change what the inbox holds. */
export const INBOX_CHANGED_EVENT = "asael:inbox-changed";

export const MAX_APPROVAL_FOCUS_ID_LENGTH = 200;
export const MAX_APPROVAL_RETURN_TO_LENGTH = 512;

const RETURN_BASE = "https://return.invalid";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function parseApprovalKind(value: unknown): ApprovalKind | undefined {
  return typeof value === "string" &&
    (APPROVAL_KINDS as readonly string[]).includes(value)
    ? (value as ApprovalKind)
    : undefined;
}

export function parseApprovalFocusId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (
    !id ||
    id.length > MAX_APPROVAL_FOCUS_ID_LENGTH ||
    CONTROL_CHARACTERS.test(id)
  ) {
    return undefined;
  }
  return id;
}

/**
 * Where to send someone after they decide. Only a path inside the app is
 * kept: never another origin, a protocol-relative or backslash URL, or the
 * inbox itself, which would send them straight back.
 */
export function safeApprovalReturnTo(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_APPROVAL_RETURN_TO_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s]/.test(value) ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, RETURN_BASE);
  } catch {
    return undefined;
  }
  const { pathname } = url;
  if (
    url.origin !== RETURN_BASE ||
    (pathname !== "/app" && !pathname.startsWith("/app/")) ||
    pathname === "/app/approvals" ||
    pathname.startsWith("/app/approvals/")
  ) {
    return undefined;
  }
  return `${pathname}${url.search}${url.hash}`;
}

/** The words for a link back to a path `safeApprovalReturnTo` kept. */
export function approvalReturnLabel(returnTo: string) {
  const { pathname } = new URL(returnTo, RETURN_BASE);
  return pathname === "/app/command" ? "Back to conversation" : "Go back";
}

/** The inbox, optionally opened on one item and able to send you back. */
export function approvalInboxHref({
  id,
  kind,
  returnTo,
}: {
  id?: string;
  kind?: ApprovalKind;
  returnTo?: string;
} = {}) {
  const params = new URLSearchParams();
  const focusId = parseApprovalFocusId(id);
  if (focusId) {
    params.set("id", focusId);
    const focusKind = parseApprovalKind(kind);
    if (focusKind) params.set("kind", focusKind);
  }
  const back = safeApprovalReturnTo(returnTo);
  if (back) params.set("returnTo", back);
  const query = params.toString();
  return query ? `/app/approvals?${query}` : "/app/approvals";
}

/** The conversation a run belongs to, reopened on that run. */
export function commandConversationHref({
  threadId,
  runId,
}: {
  threadId?: string;
  runId?: string;
}) {
  const params = new URLSearchParams();
  if (threadId) params.set("thread", threadId);
  if (runId) params.set("run", runId);
  const query = params.toString();
  return query ? `/app/command?${query}` : "/app/command";
}

export type InboxCount = {
  /** Everything waiting that the caller may decide. */
  pending: number;
  /** Present when the caller may decide agent and workflow actions. */
  approvals?: number;
  /** Present when the caller may decide workspace access requests. */
  accessRequests?: number;
};

export function readInboxCount(value: unknown): InboxCount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const pending = countValue(record.pending);
  if (pending === undefined) return undefined;
  const approvals = countValue(record.approvals);
  const accessRequests = countValue(record.accessRequests);
  return {
    pending,
    ...(approvals === undefined ? {} : { approvals }),
    ...(accessRequests === undefined ? {} : { accessRequests }),
  };
}

/** The text of a count badge: nothing for zero, and 99+ past 99. */
export function inboxBadgeLabel(count: number | undefined) {
  if (count === undefined || !Number.isFinite(count) || count < 1) return "";
  return count > 99 ? "99+" : String(Math.trunc(count));
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
