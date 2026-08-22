"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Loader2,
  LockKeyhole,
  RefreshCw,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { useLiveRefresh } from "@/components/use-live-refresh";

type JsonRecord = Record<string, unknown>;
type ResourceStatus = "idle" | "loading" | "ready" | "error" | "unavailable";
type ResourceKey = "runs" | "workflows" | "approvals" | "incidents";
type Tone = "neutral" | "success" | "warning" | "danger";

type ResourceState = {
  status: ResourceStatus;
  data?: JsonRecord;
  error?: string;
};

type ActivityRow = {
  key: string;
  title: string;
  status: string;
  detail: string;
  timestamp: number;
  time: string;
  href: string;
  kind: "agent" | "workflow";
  result?: string;
};

const initialResources: Record<ResourceKey, ResourceState> = {
  runs: { status: "idle" },
  workflows: { status: "idle" },
  approvals: { status: "idle" },
  incidents: { status: "idle" },
};

export function DashboardOverview() {
  const {
    session,
    status: sessionStatus,
    error: sessionError,
    role,
  } = useWorkspaceSession();
  const [resources, setResources] = useState(initialResources);
  const [lastRefresh, setLastRefresh] = useState<string>();
  const [announcement, setAnnouncement] = useState("Activity workspace ready.");
  const loadVersionRef = useRef(0);

  const workspaceAvailable = Boolean(
    session && (!session.authEnabled || session.authenticated),
  );
  const canUseInbox = canPerform(role, "manage.workflow");
  const canReadIncidents = canPerform(role, "read.security");
  const isLoading =
    sessionStatus === "loading" ||
    Object.values(resources).some((resource) => resource.status === "loading");
  const hasPriorData = Object.values(resources).some((resource) => Boolean(resource.data));

  async function load() {
    if (sessionStatus !== "ready" || !session) {
      return;
    }
    const loadVersion = ++loadVersionRef.current;
    if (session.authEnabled && !session.authenticated) {
      setResources({
        runs: { status: "unavailable", error: "Sign in to load agent runs." },
        workflows: { status: "unavailable", error: "Sign in to load workflows." },
        approvals: { status: "unavailable", error: "Sign in to load Inbox." },
        incidents: { status: "unavailable", error: "Sign in to load incidents." },
      });
      return;
    }

    setAnnouncement("Refreshing activity.");
    setResources((current) => ({
      runs: { status: "loading", data: current.runs.data },
      workflows: { status: "loading", data: current.workflows.data },
      approvals: canUseInbox
        ? { status: "loading", data: current.approvals.data }
        : { status: "unavailable", error: "Operator role required for approval items." },
      incidents: canReadIncidents
        ? { status: "loading", data: current.incidents.data }
        : { status: "unavailable", error: "Admin role required for incident details." },
    }));

    const entries = await Promise.all([
      loadResource("runs", "/api/runs?limit=16"),
      loadResource("workflows", "/api/workflows?limit=16"),
      canUseInbox
        ? loadResource("approvals", "/api/approvals?limit=12")
        : Promise.resolve(["approvals", { status: "unavailable", error: "Operator role required for approval items." }] as const),
      canReadIncidents
        ? loadResource("incidents", "/api/incidents?status=active&limit=8")
        : Promise.resolve(["incidents", { status: "unavailable", error: "Admin role required for incident details." }] as const),
    ]);
    if (loadVersion !== loadVersionRef.current) {
      return;
    }

    setResources(Object.fromEntries(entries) as Record<ResourceKey, ResourceState>);
    setLastRefresh(new Date().toLocaleTimeString());
    setAnnouncement(
      entries.some(([, resource]) => resource.status === "error")
        ? "Activity refreshed with unavailable sources."
        : "Activity refreshed.",
    );
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (sessionStatus === "ready") {
        void load();
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // Session changes are the only automatic refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, role]);

  const activityRows = useMemo(
    () =>
      mergeActivity(
        arrayPath(resources.runs.data, "runs"),
        arrayPath(resources.workflows.data, "runs"),
      ),
    [resources.runs.data, resources.workflows.data],
  );
  const activeRows = activityRows.filter((row) =>
    ["running", "queued", "pending", "waiting_approval", "paused"].includes(
      row.status.toLowerCase(),
    ),
  );
  const completedRows = activityRows.filter((row) => row.status.toLowerCase() === "completed");
  useLiveRefresh({
    enabled: workspaceAvailable,
    onRefresh: load,
    pollIntervalMs: activeRows.length ? 8_000 : undefined,
  });
  const approvals = arrayPath(resources.approvals.data, "items");
  const incidents = arrayPath(resources.incidents.data, "incidents");
  const sourceErrors = (Object.entries(resources) as Array<[ResourceKey, ResourceState]>)
    .filter(([, resource]) => resource.status === "error");

  return (
    <div
      className="px-4 py-6 sm:px-6 lg:px-8"
      aria-busy={isLoading}
      data-testid="activity-workspace"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <Activity size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold text-primary">Activity</p>
                <h1 className="mt-1 text-2xl font-semibold">Watch work move.</h1>
              </div>
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-muted">
              Follow active and recent agent runs and workflows. Approval requests and incidents stay in Inbox. Completed output stays in Results.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={isLoading || !workspaceAvailable}
              className="action-button"
            >
              {isLoading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              Refresh activity
            </button>
            <Link href="/app/command" className="primary-button">
              New work
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            label="Active runs"
            value={metricValue(resources.runs, activeRows.filter((row) => row.kind === "agent").length)}
            tone={metricTone(resources.runs, activeRows.some((row) => row.kind === "agent") ? "warning" : "neutral")}
          />
          <Metric
            label="Active workflows"
            value={metricValue(resources.workflows, activeRows.filter((row) => row.kind === "workflow").length)}
            tone={metricTone(resources.workflows, activeRows.some((row) => row.kind === "workflow") ? "warning" : "neutral")}
          />
          <Metric
            label="Needs attention"
            value={attentionMetric(resources.approvals, resources.incidents, approvals.length + incidents.length)}
            tone={attentionTone(resources.approvals, resources.incidents, approvals.length + incidents.length)}
          />
          <Metric
            label="Completed"
            value={combinedMetric(resources.runs, resources.workflows, completedRows.length)}
            tone={combinedTone(resources.runs, resources.workflows, completedRows.length)}
          />
          <Metric label="Updated" value={lastRefresh || (isLoading ? "Loading" : "Unknown")} tone="neutral" />
        </div>
      </section>

      {sessionStatus === "error" ? (
        <StateNotice
          tone="danger"
          title="Session status unavailable"
          body={sessionError || "Refresh the page before relying on workspace activity."}
        />
      ) : null}

      {session?.authEnabled && !session.authenticated && sessionStatus === "ready" ? (
        <section className="mt-4 flex flex-col gap-3 rounded-lg border border-warning/45 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <LockKeyhole size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold">Sign in to load workspace activity</h2>
              <p className="mt-1 text-sm leading-6 text-muted">No protected endpoint was called while your session was signed out.</p>
            </div>
          </div>
          <Link href="/login" className="primary-button shrink-0">Sign in</Link>
        </section>
      ) : null}

      {isLoading && hasPriorData ? (
        <StateNotice
          tone="neutral"
          title="Refreshing"
          body="Showing the last loaded activity until every source responds."
        />
      ) : null}

      {sourceErrors.length ? (
        <section className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-4" aria-labelledby="activity-errors">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
            <div>
              <h2 id="activity-errors" className="text-sm font-semibold">Some activity could not be loaded</h2>
              <ul className="mt-2 space-y-1 text-sm leading-6 text-muted">
                {sourceErrors.map(([key, resource]) => (
                  <li key={key}><strong className="text-foreground">{resourceLabel(key)}:</strong> {resource.error}</li>
                ))}
              </ul>
              <button type="button" onClick={() => void load()} className="action-button mt-3">Retry activity</button>
            </div>
          </div>
        </section>
      ) : null}

      {workspaceAvailable ? (
        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
          <Panel title="Active and recent work" description="Latest state first across agent runs and durable workflows.">
            {isLoading && !hasPriorData ? (
              <LoadingRows />
            ) : activityRows.length ? (
              <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
                {activityRows.slice(0, 12).map((row) => <ActivityItem key={row.key} row={row} />)}
              </div>
            ) : resources.runs.status === "ready" && resources.workflows.status === "ready" ? (
              <EmptyState
                title="No work has started"
                body="Create a bounded goal in Work. The run will appear here as soon as execution starts."
                href="/app/command"
                linkLabel="Create work"
              />
            ) : (
              <UnavailableState label="Activity state is unknown because its sources are unavailable." />
            )}
          </Panel>

          <div className="space-y-4">
            <Panel title="Needs attention" description="Action approvals and active incidents, routed to their owning workspace.">
              {resources.approvals.status === "unavailable" && resources.incidents.status === "unavailable" ? (
                <UnavailableState label={`${resources.approvals.error} ${resources.incidents.error}`} />
              ) : approvals.length || incidents.length ? (
                <div className="space-y-2">
                  {approvals.slice(0, 5).map((item) => (
                    <AttentionItem key={`approval-${stringValue(item.id)}`} item={item} kind="approval" />
                  ))}
                  {incidents.slice(0, 3).map((item) => (
                    <AttentionItem key={`incident-${stringValue(item.id)}`} item={item} kind="incident" />
                  ))}
                </div>
              ) : resources.approvals.status === "ready" || resources.incidents.status === "ready" ? (
                <EmptyState
                  title="Nothing needs attention"
                  body="No visible approval request or active incident is waiting."
                  href="/app/approvals"
                  linkLabel="Review approval queue"
                />
              ) : (
                <LoadingRows compact />
              )}
            </Panel>

            <Panel title="Recent results" description="Completed work with result evidence.">
              {completedRows.length ? (
                <div className="space-y-2">
                  {completedRows.slice(0, 4).map((row) => <ActivityItem key={`result-${row.key}`} row={row} compact />)}
                </div>
              ) : resources.runs.status === "ready" && resources.workflows.status === "ready" ? (
                <EmptyState
                  title="No completed result yet"
                  body="Active, blocked, failed, and canceled work remains in Activity until a result completes."
                  href="/app/results"
                  linkLabel="Open Results"
                />
              ) : (
                <UnavailableState label="Completed result state is not available yet." />
              )}
            </Panel>
          </div>
        </section>
      ) : null}

      <details className="mt-4 rounded-lg border border-line bg-surface p-4">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">Advanced workspaces</summary>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          Use these when a result needs deeper context, configuration, verification, or system diagnosis.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/app/workflows" className="action-link">Workflow queue</Link>
          <Link href="/app/memory" className="action-link">Knowledge</Link>
          <Link href="/app/evaluations" className="action-link">Evaluations</Link>
          <Link href="/app/observability" className="action-link">Monitoring</Link>
          <Link href="/app/settings" className="action-link">Settings</Link>
        </div>
      </details>
    </div>
  );
}

async function loadResource(key: ResourceKey, path: string) {
  try {
    const data = await readJson(path);
    return [key, { status: "ready", data }] as const;
  } catch (error) {
    return [
      key,
      {
        status: "error",
        error: error instanceof Error ? error.message : "Request failed.",
      },
    ] as const;
  }
}

function mergeActivity(agentRuns: JsonRecord[], workflowRuns: JsonRecord[]) {
  return [
    ...agentRuns.map((item): ActivityRow => {
      const time = stringValue(item.completedAt || item.updatedAt || item.startedAt || item.createdAt);
      return {
        key: `agent-${stringValue(item.id, `${stringValue(item.prompt)}-${time}`)}`,
        title: stringValue(item.prompt, "Agent run"),
        status: stringValue(item.status, "unknown"),
        detail: stringValue(item.mode, "agent"),
        timestamp: timestampValue(time),
        time,
        href: "/app/command",
        kind: "agent",
        result: stringValue(item.response || item.error),
      };
    }),
    ...workflowRuns.map((item): ActivityRow => {
      const time = stringValue(item.completedAt || item.updatedAt || item.createdAt);
      return {
        key: `workflow-${stringValue(item.id, `${stringValue(item.goal)}-${time}`)}`,
        title: stringValue(item.goal, "Workflow"),
        status: stringValue(item.status, "unknown"),
        detail: stringValue(item.currentStep, "workflow"),
        timestamp: timestampValue(time),
        time,
        href: "/app/workflows",
        kind: "workflow",
        result: stringValue(readPath(item, "result.report") || item.error),
      };
    }),
  ].sort((a, b) => b.timestamp - a.timestamp);
}

function ActivityItem({ row, compact = false }: { row: ActivityRow; compact?: boolean }) {
  const Icon = row.kind === "agent" ? TerminalSquare : Workflow;
  return (
    <Link
      href={row.href}
      className={clsx(
        "block bg-background transition hover:bg-surface-raised",
        compact ? "rounded-md border border-line p-3" : "p-3",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-surface-raised text-primary">
          <Icon size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{row.title}</p>
              <p className="mt-1 text-xs text-muted">{row.detail} · {formatTime(row.time)}</p>
            </div>
            <StatusBadge status={row.status} />
          </div>
          {row.result && compact ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{row.result}</p> : null}
        </div>
      </div>
    </Link>
  );
}

function AttentionItem({ item, kind }: { item: JsonRecord; kind: "approval" | "incident" }) {
  const status = kind === "approval" ? stringValue(item.status, "waiting_approval") : stringValue(item.status, "open");
  return (
    <Link href={kind === "approval" ? "/app/approvals" : "/app/observability"} className="block rounded-md border border-line bg-background p-3 hover:bg-surface-raised">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{stringValue(item.title || item.summary, kind === "approval" ? "Approval request" : "Incident")}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{stringValue(item.reason || item.severity, "Review required.")}</p>
          <div className="mt-2"><StatusBadge status={status} /></div>
        </div>
      </div>
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = toneForStatus(status);
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? Clock3 : tone === "danger" ? AlertTriangle : CircleHelp;
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs", pillTone(tone))}>
      <Icon size={13} aria-hidden="true" />
      {status}
    </span>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="bg-background p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx("mt-2 font-mono text-lg", textTone(tone))}>{value}</p>
    </div>
  );
}

function EmptyState({ title, body, href, linkLabel }: { title: string; body: string; href: string; linkLabel: string }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-background p-4">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
      <Link href={href} className="action-link mt-3">{linkLabel}</Link>
    </div>
  );
}

function UnavailableState({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-background p-4">
      <CircleHelp size={17} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <p className="text-sm leading-6 text-muted">{label}</p>
    </div>
  );
}

function LoadingRows({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading activity">
      {[0, 1, 2].slice(0, compact ? 2 : 3).map((index) => (
        <div key={index} className="rounded-md border border-line bg-background p-3">
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-raised" />
          <div className="mt-3 h-3 w-1/3 animate-pulse rounded bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}

function StateNotice({ tone, title, body }: { tone: "neutral" | "danger"; title: string; body: string }) {
  return (
    <section className={clsx("mt-4 rounded-lg border p-4", tone === "danger" ? "border-danger/40 bg-danger/10" : "border-info/40 bg-info/10")} role={tone === "danger" ? "alert" : "status"}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
    </section>
  );
}

function metricValue(resource: ResourceState, value: number) {
  if (resource.status === "loading" || resource.status === "idle") return "Loading";
  if (resource.status === "error") return "Unavailable";
  if (resource.status === "unavailable") return "Restricted";
  return value.toString();
}

function combinedMetric(first: ResourceState, second: ResourceState, value: number) {
  if (first.status === "error" || second.status === "error") return "Unavailable";
  if (first.status === "unavailable" || second.status === "unavailable") return "Restricted";
  if (first.status === "loading" || second.status === "loading" || first.status === "idle" || second.status === "idle") return "Loading";
  return value.toString();
}

function attentionMetric(approvals: ResourceState, incidents: ResourceState, value: number) {
  if (approvals.status === "error" || incidents.status === "error") return "Unavailable";
  if (approvals.status === "unavailable" && incidents.status === "unavailable") return "Restricted";
  if (approvals.status === "unavailable" || incidents.status === "unavailable") return "Partial";
  if (approvals.status === "loading" || incidents.status === "loading") return "Loading";
  return value.toString();
}

function attentionTone(approvals: ResourceState, incidents: ResourceState, value: number): Tone {
  if (approvals.status !== "ready" || incidents.status !== "ready") return "neutral";
  return value ? "warning" : "success";
}

function combinedTone(first: ResourceState, second: ResourceState, value: number): Tone {
  if (first.status !== "ready" || second.status !== "ready") return "neutral";
  return value ? "success" : "neutral";
}

function metricTone(resource: ResourceState, tone: Tone): Tone {
  return resource.status === "ready" ? tone : "neutral";
}

function resourceLabel(key: ResourceKey) {
  if (key === "runs") return "Agent runs";
  if (key === "workflows") return "Workflows";
  if (key === "approvals") return "Inbox";
  return "Incidents";
}

async function readJson(path: string) {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(body);
    throw new Error(stringValue(record.message || record.error, `${path} returned ${response.status}.`));
  }
  return asRecord(body);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => asRecord(current)[segment], source);
}

function arrayPath(source: unknown, path: string): JsonRecord[] {
  const value = readPath(source, path);
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function timestampValue(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function toneForStatus(value: unknown): Tone {
  const status = stringValue(value).toLowerCase();
  if (["completed", "success", "approved", "healthy", "ready"].includes(status)) return "success";
  if (["running", "queued", "pending", "waiting_approval", "paused", "degraded"].includes(status)) return "warning";
  if (["failed", "blocked", "rejected", "canceled", "error", "unhealthy", "open"].includes(status)) return "danger";
  return "neutral";
}

function pillTone(tone: Tone) {
  if (tone === "success") return "bg-success/10 text-success";
  if (tone === "warning") return "bg-warning/10 text-warning";
  if (tone === "danger") return "bg-danger/10 text-danger";
  return "bg-surface-raised text-muted";
}

function textTone(tone: Tone) {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "danger") return "text-danger";
  return "text-foreground";
}
