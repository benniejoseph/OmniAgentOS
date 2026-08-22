export type ResultRecord = Record<string, unknown>;
export type ResultTone = "neutral" | "success" | "warning" | "danger";

export type ResultTimelineItem = {
  key: string;
  kind: "agent" | "workflow" | "approval";
  title: string;
  status: string;
  body: string;
  meta: string;
  href: string;
  tone: ResultTone;
  timestamp: number;
};

export function buildResultTimeline({
  agentRuns,
  workflowRuns,
  approvalItems,
}: {
  agentRuns: ResultRecord[];
  workflowRuns: ResultRecord[];
  approvalItems: ResultRecord[];
}) {
  const items: ResultTimelineItem[] = [
    ...agentRuns.map(agentTimelineItem),
    ...workflowRuns.map(workflowTimelineItem),
    ...approvalItems.map(approvalTimelineItem),
  ];
  const latestByKey = new Map<string, ResultTimelineItem>();
  for (const item of items) {
    const current = latestByKey.get(item.key);
    if (!current || item.timestamp >= current.timestamp) {
      latestByKey.set(item.key, item);
    }
  }
  return [...latestByKey.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function agentTimelineItem(item: ResultRecord): ResultTimelineItem {
  const status = stringValue(item.status, "unknown");
  const timestampValue = firstString(item.completedAt, item.updatedAt, item.startedAt, item.createdAt);
  const key = `agent:${stringValue(item.id, `${stringValue(item.prompt)}:${timestampValue}`)}`;
  return {
    key,
    kind: "agent",
    title: stringValue(item.prompt, "Agent run"),
    status,
    body: fullText(item.response || item.error, finalState(status) ? "No result text was stored." : "This run has not produced a final result yet."),
    meta: `${stringValue(item.mode, "agent")} / ${formatResultTime(timestampValue)}`,
    href: `/app/results?run=${encodeURIComponent(key)}`,
    tone: toneForResultStatus(status),
    timestamp: parsedTime(timestampValue),
  };
}

function workflowTimelineItem(item: ResultRecord): ResultTimelineItem {
  const status = stringValue(item.status, "unknown");
  const timestampValue = firstString(item.completedAt, item.updatedAt, item.createdAt);
  const key = `workflow:${stringValue(item.id, `${stringValue(item.goal)}:${timestampValue}`)}`;
  return {
    key,
    kind: "workflow",
    title: stringValue(item.goal, "Workflow"),
    status,
    body: fullText(readPath(item, "result.report") || item.error, finalState(status) ? "No final report was stored." : "This workflow has not produced a final report yet."),
    meta: `${stringValue(item.currentStep, "workflow")} / ${formatResultTime(timestampValue)}`,
    href: `/app/results?run=${encodeURIComponent(key)}`,
    tone: toneForResultStatus(status),
    timestamp: parsedTime(timestampValue),
  };
}

function approvalTimelineItem(item: ResultRecord): ResultTimelineItem {
  const status = stringValue(item.status, "waiting_approval");
  const timestampValue = firstString(item.updatedAt, item.createdAt);
  return {
    key: `approval:${stringValue(item.id, `${stringValue(item.title)}:${timestampValue}`)}`,
    kind: "approval",
    title: stringValue(item.title, "Approval required"),
    status,
    body: fullText(item.reason || readPath(item, "record.error"), "This work is paused until an operator approves or rejects the request."),
    meta: `${stringValue(item.kind, "approval")} / risk ${stringValue(item.riskLevel, "unknown")} / ${formatResultTime(timestampValue)}`,
    href: "/app/approvals",
    tone: toneForResultStatus(status),
    timestamp: parsedTime(timestampValue),
  };
}

export function toneForResultStatus(value: unknown): ResultTone {
  const text = stringValue(value).toLowerCase();
  if (["healthy", "passed", "success", "completed", "executed", "approved", "ready"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting_approval", "queued", "running", "paused", "pending", "degraded", "dry_run"].includes(text)) {
    return "warning";
  }
  if (["canceled", "cancelled"].includes(text)) {
    return "neutral";
  }
  if (["error", "failed", "blocked", "deny", "denied", "unhealthy", "rejected", "timeout", "timed_out", "open"].includes(text)) {
    return "danger";
  }
  return "neutral";
}

export function formatResultTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value || "time unknown";
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function finalState(status: string) {
  return ["completed", "failed", "blocked", "rejected", "canceled", "cancelled", "timeout", "timed_out"].includes(status.toLowerCase());
}

function fullText(value: unknown, fallback: string) {
  return stringValue(value, fallback).trim();
}

function parsedTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => asRecord(current)[segment], source);
}

function asRecord(value: unknown): ResultRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ResultRecord) : {};
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
