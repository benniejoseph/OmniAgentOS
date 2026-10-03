import {
  ACTIVITY_CONTRACT,
  ACTIVITY_GROUPS,
  ACTIVITY_SOURCE_LIMIT,
  type ActivityFilter,
  type ActivityItem,
  type ActivityReference,
  type ActivityResponse,
} from "@/lib/activity/contracts";
import { CANONICAL_STATUSES, type CanonicalStatusProjection } from "@/lib/status/canonical";

export const ACTIVITY_PAGE_LIMIT = 25;
const sources = ["runs", "approvals", "notifications"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validTime = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const member = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.some((item) => item === value);

function internalHref(value: unknown): value is string {
  if (!text(value) || !value.startsWith("/") || value.startsWith("//") || /[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value, "https://activity.invalid");
    return url.origin === "https://activity.invalid" && (url.pathname === "/app" || url.pathname.startsWith("/app/"));
  } catch { return false; }
}

function validReference(value: unknown): value is ActivityReference {
  return isRecord(value) && member(value.kind, ["run", "approval", "notification", "today_item"]) && text(value.id) &&
    (value.approvalKind === undefined || member(value.approvalKind, ["tool", "workflow", "slo_policy"]));
}

function validCanonicalStatus(value: unknown, source: ActivityItem["source"]): value is CanonicalStatusProjection {
  if (source === "notifications" || !isRecord(value) || value.schemaVersion !== 1 || !member(value.status, CANONICAL_STATUSES) ||
    value.domain !== (source === "runs" ? "agent_run" : "approval") ||
    !member(value.basis, ["legacy_status", "terminal_receipt"]) ||
    !member(value.source, ["legacy_adapter", "outcome_evaluator", "unknown"]) || !text(value.sourceStatus) ||
    !member(value.verificationState, ["verified", "partially_verified", "unverified", "not_applicable", "unassessed"])) return false;
  if (value.basis === "legacy_status" && (value.source !== "legacy_adapter" || value.verificationState !== "unassessed")) return false;
  // Completion alone, or a legacy status adapter, cannot establish verified success.
  return value.status !== "succeeded" || (source === "runs" && value.basis === "terminal_receipt" &&
    value.source === "outcome_evaluator" && value.verificationState === "verified" && value.sourceStatus === "succeeded");
}

function validItem(value: unknown, group: ActivityFilter): value is ActivityItem {
  if (!isRecord(value) || !text(value.id) || !text(value.workKey) || !text(value.title) || !text(value.summary) || !text(value.status) ||
    !member(value.group, ACTIVITY_GROUPS) || (group !== "all" && value.group !== group) ||
    !member(value.source, sources) || !validReference(value.sourceRef) ||
    !Array.isArray(value.references) || !value.references.every(validReference) || !internalHref(value.href) ||
    !isRecord(value.timestamp) || !validTime(value.timestamp.at) || !member(value.timestamp.basis, ["started", "completed", "created", "updated"])) return false;
  if (value.origin !== undefined && (!isRecord(value.origin) || !text(value.origin.runId) || !internalHref(value.origin.href) ||
    (value.origin.threadId !== undefined && !text(value.origin.threadId)))) return false;
  if (value.source === "notifications" && (value.workKey.startsWith("responsibility:") || value.href.startsWith("/app/responsibilities/"))) {
    if (!/^responsibility:[a-f0-9]{64}$/.test(value.workKey) || value.sourceRef.kind !== "notification" ||
      value.href !== `/app/responsibilities/${encodeURIComponent(value.workKey)}` || !member(value.status, ["unread", "read", "dismissed"])) return false;
  }
  return value.canonicalStatus === undefined || validCanonicalStatus(value.canonicalStatus, value.source);
}

/** Reject malformed reads as unavailable; never manufacture rows or success claims. */
export function validActivityResponse(value: unknown, group: ActivityFilter): value is ActivityResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.contract !== ACTIVITY_CONTRACT || value.group !== group ||
    !validTime(value.generatedAt) || !member(value.state, ["ready", "partial", "unavailable"]) ||
    !Array.isArray(value.items) || value.items.length > ACTIVITY_PAGE_LIMIT || !value.items.every((item) => validItem(item, group)) ||
    !isRecord(value.counts) || !ACTIVITY_GROUPS.every((key) => count((value.counts as Record<string, unknown>)[key])) ||
    !isRecord(value.coverage) || !sources.every((key) => {
      const coverage = (value.coverage as Record<string, unknown>)[key];
      return isRecord(coverage) && member(coverage.state, ["ready", "partial", "restricted", "unavailable"]) &&
        coverage.limit === ACTIVITY_SOURCE_LIMIT && (coverage.visibleCount === null || (count(coverage.visibleCount) && coverage.visibleCount <= ACTIVITY_SOURCE_LIMIT));
    }) || !isRecord(value.window) || value.window.bounded !== true || value.window.limitPerSource !== ACTIVITY_SOURCE_LIMIT ||
    !isRecord(value.page) || value.page.limit !== ACTIVITY_PAGE_LIMIT || typeof value.page.hasMore !== "boolean" ||
    (value.page.hasMore ? !text(value.page.nextCursor) || value.page.nextCursor.length > 2000 : value.page.nextCursor !== null)) return false;
  const counts = value.counts as ActivityResponse["counts"];
  const total = ACTIVITY_GROUPS.reduce((sum, key) => sum + counts[key], 0);
  return new Set(value.items.map((item) => item.id)).size === value.items.length && total <= sources.length * ACTIVITY_SOURCE_LIMIT &&
    value.items.length <= (group === "all" ? total : counts[group]);
}
