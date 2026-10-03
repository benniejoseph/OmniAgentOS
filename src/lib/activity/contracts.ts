import type { CanonicalStatusProjection } from "@/lib/status/canonical";

export const ACTIVITY_CONTRACT = "asael-activity:1" as const;
export const ACTIVITY_SOURCE_LIMIT = 100 as const;
export const ACTIVITY_GROUPS = ["working", "needs_you", "updates", "history"] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];
export type ActivityFilter = ActivityGroup | "all";
export type ActivitySource = "runs" | "approvals" | "notifications";
export type ActivityReference = {
  kind: "run" | "approval" | "notification" | "today_item";
  id: string;
  approvalKind?: "tool" | "workflow" | "slo_policy";
};
export type ActivityItem = {
  id: string;
  group: ActivityGroup;
  workKey: string;
  source: ActivitySource;
  sourceRef: ActivityReference;
  references: ActivityReference[];
  title: string;
  summary: string;
  status: string;
  canonicalStatus?: CanonicalStatusProjection;
  timestamp: { at: string; basis: "started" | "completed" | "created" | "updated" };
  href: string;
  origin?: { runId: string; threadId?: string; href: string };
};
export type ActivityCoverage = {
  state: "ready" | "partial" | "restricted" | "unavailable";
  limit: typeof ACTIVITY_SOURCE_LIMIT;
  visibleCount: number | null;
  reason?: "permission_required" | "read_failed" | "records_omitted";
};
export type ActivityResponse = {
  schemaVersion: 1;
  contract: typeof ACTIVITY_CONTRACT;
  generatedAt: string;
  state: "ready" | "partial" | "unavailable";
  group: ActivityFilter;
  items: ActivityItem[];
  /** Counts cover only this bounded, currently readable window. */
  counts: Record<ActivityGroup, number>;
  coverage: Record<ActivitySource, ActivityCoverage>;
  window: { bounded: true; limitPerSource: typeof ACTIVITY_SOURCE_LIMIT };
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
};
export type ActivityQuery = { group: ActivityFilter; limit: number; cursor?: string };
