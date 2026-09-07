import type { CustomerSuccessPortfolio } from "@/lib/customer-success/intelligence-contracts";
import type { MeetingRevision } from "@/lib/meetings/contracts";
import {
  DEFAULT_TODAY_SECTIONS,
  normalizeTodaySections,
  TODAY_SECTION_KEYS,
  type TodaySectionKey,
} from "@/lib/today/sections";
import type { TodaySnapshot } from "@/lib/today/snapshot";
import type { UsageSummary } from "@/lib/usage/summary";
import type { WorkspaceSummary, WorkspaceSummarySource } from "@/lib/workspace/summary";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const COHESIVE_TODAY_POLICY_VERSION = "p11.1-cohesive-today:1" as const;

export { DEFAULT_TODAY_SECTIONS, normalizeTodaySections, TODAY_SECTION_KEYS };
export type { TodaySectionKey };

export type TodayProjectionSourceKey =
  | "personal_reminders"
  | "meetings"
  | "commitments"
  | "customer_risks"
  | "approvals"
  | "active_agents"
  | "work"
  | "consumption";

export type TodayProjectionSourceState = Readonly<{
  source: TodayProjectionSourceKey;
  status: "ready" | "restricted" | "error" | "hidden";
  freshness: "current" | "unknown";
  observedAt: string;
  lastChangedAt: string | null;
  detail: string;
}>;

export type TodayAgendaItem = Readonly<{
  itemId: string;
  kind: "reminder" | "meeting" | "commitment" | "approval" | "customer_risk";
  priority: "urgent" | "high" | "normal";
  title: string;
  detail: string;
  scheduledAt: string | null;
  href: string;
  sourceId: string;
  sourceRevisionId: string | null;
}>;

export type CohesiveTodayProjection = Readonly<{
  policyVersion: typeof COHESIVE_TODAY_POLICY_VERSION;
  generatedAt: string;
  timezone: string;
  visibleSections: readonly TodaySectionKey[];
  today: TodaySnapshot;
  workspaceSummary: WorkspaceSummary | null;
  meetings: readonly MeetingRevision[];
  customerPortfolio: CustomerSuccessPortfolio | null;
  usage: UsageSummary | null;
  agenda: readonly TodayAgendaItem[];
  sources: readonly TodayProjectionSourceState[];
  counts: Readonly<{
    needsAttention: number;
    meetingsToday: number;
    openCommitments: number;
    approvals: number;
    activeAgents: number;
    activeWork: number;
    unknownSources: number;
  }>;
  projectionSha256: string;
}>;

type OptionalSource<T> = Readonly<{
  status: "ready" | "restricted" | "error" | "hidden";
  value?: T;
  detail?: string;
}>;

export function buildCohesiveTodayProjection(input: {
  today: TodaySnapshot;
  workspaceSummary: OptionalSource<WorkspaceSummary>;
  meetings: OptionalSource<readonly MeetingRevision[]>;
  customerPortfolio: OptionalSource<CustomerSuccessPortfolio>;
  usage: OptionalSource<UsageSummary>;
  generatedAt?: string;
}): CohesiveTodayProjection {
  const generatedAt = canonicalTimestamp(input.generatedAt || new Date().toISOString());
  const visibleSections = normalizeTodaySections(input.today.preferences.visibleSections);
  const meetings = input.meetings.status === "ready" ? input.meetings.value || [] : [];
  const workspaceSummary = input.workspaceSummary.status === "ready"
    ? input.workspaceSummary.value || null
    : null;
  const customerPortfolio = input.customerPortfolio.status === "ready"
    ? input.customerPortfolio.value || null
    : null;
  const usage = input.usage.status === "ready" ? input.usage.value || null : null;
  const agenda = buildAgenda({
    today: input.today,
    meetings,
    approvals: readyData(workspaceSummary?.sources.approvals),
    customerPortfolio,
    generatedAt,
  });
  const sources = sourceStates({
    generatedAt,
    today: input.today,
    workspaceSummary: input.workspaceSummary,
    meetings: input.meetings,
    customerPortfolio: input.customerPortfolio,
    usage: input.usage,
  });
  const runs = readyData(workspaceSummary?.sources.runs);
  const workflows = readyData(workspaceSummary?.sources.workflows);
  const activeAgents = runs.filter((run) => activeStatus(run.status));
  const activeWork = workflows.filter((workflow) => activeStatus(workflow.status));
  const meetingCommitments = meetings.flatMap(openMeetingCommitments);
  const counts = Object.freeze({
    needsAttention: agenda.filter((item) => item.priority !== "normal").length,
    meetingsToday: meetings.filter((meeting) =>
      meeting.status !== "cancelled" &&
      localDateKey(meeting.scheduledStartAt, input.today.preferences.timezone) === input.today.briefLocalDate
    ).length,
    openCommitments: meetingCommitments.length,
    approvals: readyData(workspaceSummary?.sources.approvals).length,
    activeAgents: new Set(activeAgents.map((run) => run.agentId || run.id)).size,
    activeWork: activeAgents.length + activeWork.length,
    unknownSources: sources.filter((source) =>
      source.status === "error" || source.status === "restricted"
    ).length,
  });
  const body = {
    policyVersion: COHESIVE_TODAY_POLICY_VERSION,
    generatedAt,
    timezone: input.today.preferences.timezone,
    visibleSections,
    today: input.today,
    workspaceSummary,
    meetings,
    customerPortfolio,
    usage,
    agenda,
    sources,
    counts,
  } as const;
  return Object.freeze({
    ...body,
    projectionSha256: canonicalJsonSha256(body),
  });
}

function buildAgenda(input: {
  today: TodaySnapshot;
  meetings: readonly MeetingRevision[];
  approvals: ReturnType<typeof readyData<WorkspaceSummary["sources"]["approvals"] extends WorkspaceSummarySource<infer T> ? T : never>>;
  customerPortfolio: CustomerSuccessPortfolio | null;
  generatedAt: string;
}) {
  const nowMs = Date.parse(input.generatedAt);
  const horizonMs = nowMs + 36 * 60 * 60 * 1_000;
  const items: TodayAgendaItem[] = [];
  for (const reminder of input.today.items) {
    if (reminder.status !== "open" || reminder.kind !== "reminder") continue;
    const dueMs = reminder.dueAt ? Date.parse(reminder.dueAt) : Number.NaN;
    items.push(Object.freeze({
      itemId: `agenda:reminder:${reminder.id}`,
      kind: "reminder" as const,
      priority: reminder.reminderState === "overdue"
        ? "urgent" as const
        : reminder.reminderState === "due_soon" || reminder.priority === "high"
          ? "high" as const
          : "normal" as const,
      title: reminder.title,
      detail: reminder.reminderState === "overdue" ? "Personal reminder is overdue." : "Personal reminder.",
      scheduledAt: Number.isFinite(dueMs) ? reminder.dueAt || null : null,
      href: "/app#today-focus",
      sourceId: reminder.id,
      sourceRevisionId: null,
    }));
  }
  for (const meeting of input.meetings) {
    const startsAt = Date.parse(meeting.scheduledStartAt);
    if (meeting.status === "cancelled" || startsAt > horizonMs || startsAt < nowMs - 12 * 60 * 60 * 1_000) continue;
    items.push(Object.freeze({
      itemId: `agenda:meeting:${meeting.meetingId}`,
      kind: "meeting" as const,
      priority: meeting.status === "in_progress"
        ? "urgent" as const
        : startsAt <= nowMs + 2 * 60 * 60 * 1_000
          ? "high" as const
          : "normal" as const,
      title: meeting.title,
      detail: `${meeting.status.replaceAll("_", " ")} · ${meeting.participants.length} participants`,
      scheduledAt: meeting.scheduledStartAt,
      href: `/app/meetings/${encodeURIComponent(meeting.meetingId)}`,
      sourceId: meeting.meetingId,
      sourceRevisionId: meeting.meetingRevisionId,
    }));
    for (const commitment of openMeetingCommitments(meeting)) {
      const dueMs = commitment.dueAt ? Date.parse(commitment.dueAt) : Number.NaN;
      items.push(Object.freeze({
        itemId: `agenda:commitment:${meeting.meetingId}:${commitment.commitmentId}`,
        kind: "commitment" as const,
        priority: Number.isFinite(dueMs) && dueMs < nowMs
          ? "urgent" as const
          : Number.isFinite(dueMs) && dueMs <= horizonMs
            ? "high" as const
            : "normal" as const,
        title: commitment.summary,
        detail: commitment.ownerParticipantId ? "Confirmed meeting commitment." : "Meeting commitment with no confirmed owner.",
        scheduledAt: commitment.dueAt,
        href: `/app/meetings/${encodeURIComponent(meeting.meetingId)}`,
        sourceId: commitment.commitmentId,
        sourceRevisionId: meeting.meetingRevisionId,
      }));
    }
  }
  for (const approval of input.approvals) {
    items.push(Object.freeze({
      itemId: `agenda:approval:${approval.kind}:${approval.id}`,
      kind: "approval" as const,
      priority: "urgent" as const,
      title: approval.title,
      detail: `${approval.kind} approval · risk ${approval.riskLevel}`,
      scheduledAt: approval.createdAt,
      href: "/app/approvals",
      sourceId: approval.id,
      sourceRevisionId: null,
    }));
  }
  for (const account of input.customerPortfolio?.accounts || []) {
    if (account.attention !== "urgent" && account.attention !== "attention") continue;
    items.push(Object.freeze({
      itemId: `agenda:customer:${account.accountId}:${account.nextBestAction.recommendationId}`,
      kind: "customer_risk" as const,
      priority: account.attention === "urgent" ? "urgent" as const : "high" as const,
      title: account.name,
      detail: `${account.nextBestAction.title} · suggested, not authoritative`,
      scheduledAt: account.changedAt,
      href: `/app/accounts/${encodeURIComponent(account.accountId)}`,
      sourceId: account.accountId,
      sourceRevisionId: account.accountRevisionId,
    }));
  }
  return Object.freeze(items.sort((left, right) =>
    priorityRank(left.priority) - priorityRank(right.priority) ||
    nullableTimestamp(left.scheduledAt) - nullableTimestamp(right.scheduledAt) ||
    left.itemId.localeCompare(right.itemId)
  ).slice(0, 50));
}

function sourceStates(input: {
  generatedAt: string;
  today: TodaySnapshot;
  workspaceSummary: OptionalSource<WorkspaceSummary>;
  meetings: OptionalSource<readonly MeetingRevision[]>;
  customerPortfolio: OptionalSource<CustomerSuccessPortfolio>;
  usage: OptionalSource<UsageSummary>;
}) {
  const summary = input.workspaceSummary.value;
  const meetings = input.meetings.value || [];
  const portfolio = input.customerPortfolio.value;
  return Object.freeze([
    readyState("personal_reminders", input.generatedAt, latest([
      input.today.generatedAt,
      ...input.today.items.map((item) => item.updatedAt),
    ]), "Canonical personal tasks and reminders."),
    externalState("meetings", input.meetings, input.generatedAt, latest(meetings.map((meeting) => meeting.revisedAt)), "Canonical workspace meetings."),
    externalState("commitments", input.meetings, input.generatedAt, latest(meetings.flatMap((meeting) => [meeting.revisedAt])), "Confirmed Meeting commitments."),
    externalState("customer_risks", input.customerPortfolio, input.generatedAt, latest(portfolio?.accounts.map((account) => account.changedAt) || []), "Evidence-bound customer risks and suggestions."),
    summaryState("approvals", input.workspaceSummary, summary?.sources.approvals, input.generatedAt, "Governed actions waiting for review."),
    summaryState("active_agents", input.workspaceSummary, summary?.sources.runs, input.generatedAt, "Active agent runs and identities."),
    summaryState("work", input.workspaceSummary, summary?.sources.workflows, input.generatedAt, "Canonical project and workflow state."),
    externalState("consumption", input.usage, input.generatedAt, input.usage.value?.generatedAt || null, "Unified AI consumption ledger."),
  ] satisfies TodayProjectionSourceState[]);
}

function readyState(source: TodayProjectionSourceKey, observedAt: string, lastChangedAt: string | null, detail: string): TodayProjectionSourceState {
  return Object.freeze({ source, status: "ready", freshness: "current", observedAt, lastChangedAt, detail });
}

function externalState<T>(
  source: TodayProjectionSourceKey,
  state: OptionalSource<T>,
  observedAt: string,
  lastChangedAt: string | null,
  fallbackDetail: string,
): TodayProjectionSourceState {
  return Object.freeze({
    source,
    status: state.status,
    freshness: state.status === "ready" ? "current" : "unknown",
    observedAt,
    lastChangedAt: state.status === "ready" ? lastChangedAt : null,
    detail: state.detail || fallbackDetail,
  });
}

function summaryState<T>(
  source: TodayProjectionSourceKey,
  parent: OptionalSource<WorkspaceSummary>,
  child: WorkspaceSummarySource<T> | undefined,
  observedAt: string,
  detail: string,
): TodayProjectionSourceState {
  if (parent.status !== "ready") return externalState(source, parent, observedAt, null, detail);
  if (!child) return Object.freeze({ source, status: "error", freshness: "unknown", observedAt, lastChangedAt: null, detail: "This source did not return a projection." });
  if (child.status !== "ready") return Object.freeze({
    source,
    status: child.status,
    freshness: "unknown",
    observedAt,
    lastChangedAt: null,
    detail: child.status === "restricted"
      ? "This source is not visible to your current role."
      : "This source could not be refreshed; retry from Today.",
  });
  return readyState(source, observedAt, parent.value?.generatedAt || observedAt, detail);
}

function readyData<T>(source: WorkspaceSummarySource<T> | undefined): T extends readonly unknown[] ? T : never[];
function readyData<T>(source: WorkspaceSummarySource<T> | undefined): T | never[] {
  return source?.status === "ready" ? source.data : [];
}

function openMeetingCommitments(meeting: MeetingRevision) {
  const closed = new Set(meeting.followUps.filter((item) =>
    item.status === "completed" || item.status === "dismissed"
  ).flatMap((item) => item.commitmentId ? [item.commitmentId] : []));
  return meeting.commitments.filter((commitment) => !closed.has(commitment.commitmentId));
}

function activeStatus(status: unknown) {
  return ["running", "queued", "pending", "waiting_approval", "paused", "resuming", "waiting_clarification"].includes(String(status));
}

function priorityRank(priority: TodayAgendaItem["priority"]) {
  return priority === "urgent" ? 0 : priority === "high" ? 1 : 2;
}

function nullableTimestamp(value: string | null) {
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function latest(values: readonly (string | null | undefined)[]) {
  const valid = values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function localDateKey(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function canonicalTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("A valid Today projection time is required.");
  return date.toISOString();
}
