"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  Cable,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";

type JsonRecord = Record<string, unknown>;

type DashboardState = {
  session?: JsonRecord;
  health?: JsonRecord;
  operations?: JsonRecord;
  capabilities?: JsonRecord;
  release?: JsonRecord;
  slo?: JsonRecord;
  incidents?: JsonRecord;
};

type LoadState = "loading" | "ready" | "error";

const quickLinks = [
  {
    title: "Start agent work",
    body: "Compose a goal, retrieve context, generate a plan, and run with evidence.",
    href: "/app/command",
    icon: TerminalSquare,
  },
  {
    title: "Build workflow",
    body: "Create durable runs, triggers, approval gates, and queue recovery paths.",
    href: "/app/workflows",
    icon: Workflow,
  },
  {
    title: "Improve knowledge",
    body: "Add memories, ingest documents, test retrieval, and rebuild the graph.",
    href: "/app/memory",
    icon: Brain,
  },
  {
    title: "Review approvals",
    body: "Decide on risky tool calls, workflow gates, and SLO policy changes.",
    href: "/app/approvals",
    icon: ShieldCheck,
  },
];

export function DashboardOverview() {
  const [data, setData] = useState<DashboardState>({});
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [lastRefresh, setLastRefresh] = useState<string>();

  async function load() {
    setState("loading");
    setError(undefined);
    try {
      const [session, health] = await Promise.all([
        readJson("/api/auth/session"),
        readJson("/api/health").catch((healthError) => ({ status: "unhealthy", error: healthError instanceof Error ? healthError.message : "Health unavailable." })),
      ]);

      if (!Boolean(asRecord(session).authenticated)) {
        setData({ session: asRecord(session), health: asRecord(health) });
        setState("ready");
        setLastRefresh(new Date().toLocaleTimeString());
        return;
      }

      const [operations, capabilities, release, slo, incidents] = await Promise.all([
        readJson("/api/operations"),
        readJson("/api/capabilities"),
        readJson("/api/release/evidence"),
        readJson("/api/observability/slo"),
        readJson("/api/incidents?status=active&limit=8"),
      ]);

      setData({
        session: asRecord(session),
        health: asRecord(health),
        operations: asRecord(operations),
        capabilities: asRecord(capabilities),
        release: asRecord(release),
        slo: asRecord(slo),
        incidents: asRecord(incidents),
      });
      setState("ready");
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Control room unavailable.");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const posture = useMemo(() => computePosture(data), [data]);
  const approvals = arrayPath(data, "operations.approvals.items");
  const workflows = arrayPath(data, "operations.latest.workflows");
  const jobs = arrayPath(data, "operations.latest.operationJobs");
  const incidents = arrayPath(data, "incidents.incidents");

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <Activity size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Control Room</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">What needs attention now?</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">
              This is the operating surface for OmniAgentOS: pending approvals, active work, release risk, incidents, connector health, and production readiness.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised"
            >
              {state === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              Refresh
            </button>
            <Link
              href="/app/command"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-ink transition hover:brightness-105"
            >
              New run
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-6">
          <StatusCell label="Environment" value="Production" tone="success" />
          <StatusCell label="Health" value={stringPath(data, "health.status", "unknown")} tone={toneForStatus(readPath(data, "health.status"))} />
          <StatusCell label="Release" value={stringPath(data, "release.report.releaseGate.status", "unknown")} tone={toneForStatus(readPath(data, "release.report.releaseGate.status"))} />
          <StatusCell label="SLO" value={Boolean(readPath(data, "slo.healthy")) ? "healthy" : "watch"} tone={Boolean(readPath(data, "slo.healthy")) ? "success" : "warning"} />
          <StatusCell label="Role" value={stringPath(data, "session.membership.role", "guest")} tone="neutral" />
          <StatusCell label="Updated" value={lastRefresh || "..."} tone="neutral" />
        </div>
      </section>

      {!Boolean(readPath(data, "session.authenticated")) && state === "ready" ? (
        <section className="mt-4 rounded-lg border border-warning/45 bg-warning/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Sign in to operate the production workspace</p>
              <p className="mt-1 text-sm text-muted">The public health endpoint is visible, but approvals, workflows, release evidence, and operations require an authenticated operator.</p>
            </div>
            <Link href="/login" className="inline-flex h-10 items-center justify-center rounded-md bg-foreground px-3 text-sm font-semibold text-background">
              Sign in
            </Link>
          </div>
        </section>
      ) : null}

      {state === "error" ? (
        <section className="mt-4 rounded-lg border border-danger/45 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </section>
      ) : null}

      <section className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.22fr_0.83fr]">
        <Panel title="Action inbox" description="Blocking decisions and incidents first.">
          <div className="space-y-3">
            {approvals.slice(0, 5).map((item) => (
              <InboxRow key={stringValue(item.id)} item={item} />
            ))}
            {incidents.slice(0, 3).map((item) => (
              <InboxRow key={stringValue(item.id)} item={{ ...item, kind: "incident", riskLevel: stringValue(item.severity, "critical") }} />
            ))}
            {!approvals.length && !incidents.length ? (
              <Empty label="No approvals or active incidents are waiting." />
            ) : null}
          </div>
          <Link href="/app/approvals" className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-md border border-line bg-background text-sm font-semibold transition hover:bg-surface-raised">
            Open approval queue
          </Link>
        </Panel>

        <Panel title="Live work" description="Active workflows, queue jobs, and recent execution state.">
          <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
            <Metric label="Active workflows" value={numberPath(data, "operations.summary.activeWorkflows")} tone="success" />
            <Metric label="Pending approvals" value={numberPath(data, "operations.summary.pendingApprovals")} tone="warning" />
            <Metric label="Runnable jobs" value={numberPath(data, "operations.summary.runnableJobs")} tone="neutral" />
            <Metric label="Stale workflows" value={numberPath(data, "operations.summary.staleWorkflows")} tone="danger" />
          </div>
          <div className="mt-4 divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
            {workflows.slice(0, 6).map((workflow) => (
              <WorkRow key={stringValue(workflow.id)} item={workflow} />
            ))}
            {!workflows.length ? <Empty label="No workflow runs found." /> : null}
          </div>
          {jobs.length ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {jobs.slice(0, 4).map((job) => (
                <div key={stringValue(job.id)} className="rounded-md border border-line bg-background p-3">
                  <p className="truncate text-sm font-semibold">{stringValue(job.type || job.jobType, "Queue job")}</p>
                  <p className="mt-1 text-xs text-muted">{stringValue(job.status, "unknown")} / attempts {stringValue(job.attempts || job.attempt, "0")}</p>
                </div>
              ))}
            </div>
          ) : null}
        </Panel>

        <Panel title="Release and risk" description={`Current posture: ${posture}.`}>
          <div className="space-y-3">
            <RiskRow label="Release gate" value={stringPath(data, "release.report.releaseGate.status", "unknown")} tone={toneForStatus(readPath(data, "release.report.releaseGate.status"))} />
            <RiskRow label="SLO breaches" value={arrayPath(data, "slo.breaches").length.toString()} tone={arrayPath(data, "slo.breaches").length ? "warning" : "success"} />
            <RiskRow label="Connector errors" value={numberPath(data, "operations.summary.connectorErrors")} tone={numberPath(data, "operations.summary.connectorErrors") === "0" ? "success" : "danger"} />
            <RiskRow label="Failed tools" value={numberPath(data, "operations.summary.failedTools")} tone={numberPath(data, "operations.summary.failedTools") === "0" ? "success" : "danger"} />
            <RiskRow label="OpenAI" value={Boolean(readPath(data, "capabilities.openaiConfigured")) ? "live" : "fallback"} tone={Boolean(readPath(data, "capabilities.openaiConfigured")) ? "success" : "warning"} />
          </div>
          <Link href="/app/evaluations" className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-ink transition hover:brightness-105">
            View release evidence
          </Link>
        </Panel>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel title="Capability health" description="The operating substrate behind agent runs.">
          <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
            <Capability label="Storage" value={stringPath(data, "capabilities.storageBackend", "unknown")} icon={Database} />
            <Capability label="Memory" value={`${numberPath(data, "capabilities.memory.total")} records`} icon={Brain} />
            <Capability label="Connectors" value={`${numberPath(data, "operations.summary.connectorErrors")} errors`} icon={Cable} />
            <Capability label="Security audits" value={numberPath(data, "capabilities.security.stats.total")} icon={ShieldCheck} />
          </div>
        </Panel>

        <Panel title="Next best actions" description="These are route-specific workspaces, not informational pages.">
          <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-4">
            {quickLinks.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="group min-h-40 bg-background p-4 transition hover:bg-surface-raised">
                  <Icon size={17} className="text-primary" aria-hidden="true" />
                  <p className="mt-8 text-sm font-semibold">{item.title}</p>
                  <p className="mt-2 text-xs leading-5 text-muted">{item.body}</p>
                  <ArrowRight size={14} className="mt-4 text-muted transition group-hover:translate-x-1 group-hover:text-primary" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        </Panel>
      </section>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="bg-background p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx("mt-2 truncate font-mono text-sm", textTone(tone))}>{value}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="bg-background p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx("mt-3 font-mono text-2xl", textTone(tone))}>{value}</p>
    </div>
  );
}

function Capability({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Database }) {
  return (
    <div className="bg-background p-4">
      <Icon size={17} className="text-primary" aria-hidden="true" />
      <p className="mt-8 text-sm font-semibold">{label}</p>
      <p className="mt-2 font-mono text-sm text-muted">{value}</p>
    </div>
  );
}

function InboxRow({ item }: { item: JsonRecord }) {
  return (
    <div className="rounded-md border border-line bg-background p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 place-items-center rounded-md bg-warning/10 text-warning">
          <AlertTriangle size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{stringValue(item.title || item.summary, "Action item")}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{stringValue(item.reason || item.status, "Requires operator review.")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-md border border-line px-2 py-1 font-mono text-xs text-muted">{stringValue(item.kind, "approval")}</span>
            <span className="rounded-md border border-warning/35 bg-warning/10 px-2 py-1 font-mono text-xs text-warning">risk {stringValue(item.riskLevel, "n/a")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkRow({ item }: { item: JsonRecord }) {
  const status = stringValue(item.status, "unknown");
  return (
    <div className="grid gap-3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{stringValue(item.goal, "Workflow")}</p>
        <p className="mt-1 truncate text-xs text-muted">{stringValue(item.currentStep, "preflight")} / attempt {stringValue(item.attempt, "0")}</p>
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        <span className={clsx("rounded-md px-2 py-1 font-mono text-xs", pillTone(toneForStatus(status)))}>{status}</span>
        <span className="font-mono text-xs text-muted">{formatTime(stringValue(item.updatedAt || item.createdAt))}</span>
      </div>
    </div>
  );
}

function RiskRow({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background px-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className={clsx("font-mono text-sm", textTone(tone))}>{value}</span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm text-muted">{label}</div>;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(path: string) {
  const response = await fetch(path, { headers: { "content-type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = stringValue(asRecord(body).message || asRecord(body).error, `${path} returned ${response.status}`);
    throw new HttpError(response.status, message);
  }
  return body;
}

function computePosture(data: DashboardState) {
  const health = stringPath(data, "health.status", "unknown");
  const release = stringPath(data, "release.report.releaseGate.status", "unknown");
  const approvals = numberPath(data, "operations.summary.pendingApprovals");
  const incidents = numberPath(data, "incidents.stats.active");

  if (health === "healthy" && release === "passed" && approvals === "0" && incidents === "0") {
    return "clear";
  }
  if (health === "unhealthy" || release === "blocked" || incidents !== "0") {
    return "intervention";
  }
  return "watch";
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

function stringPath(source: unknown, path: string, fallback = "0") {
  return stringValue(readPath(source, path), fallback);
}

function numberPath(source: unknown, path: string) {
  const value = readPath(source, path);
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return "0";
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

type Tone = "neutral" | "success" | "warning" | "danger";

function toneForStatus(value: unknown): Tone {
  const text = stringValue(value).toLowerCase();
  if (["healthy", "passed", "success", "completed", "active", "allow", "approved", "ready"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting_approval", "queued", "paused", "pending", "degraded", "watch"].includes(text)) {
    return "warning";
  }
  if (["error", "failed", "blocked", "deny", "unhealthy", "rejected", "open", "critical"].includes(text)) {
    return "danger";
  }
  return "neutral";
}

function textTone(tone: Tone) {
  if (tone === "success") {
    return "text-success";
  }
  if (tone === "warning") {
    return "text-warning";
  }
  if (tone === "danger") {
    return "text-danger";
  }
  return "text-foreground";
}

function pillTone(tone: Tone) {
  if (tone === "success") {
    return "bg-success/10 text-success";
  }
  if (tone === "warning") {
    return "bg-warning/10 text-warning";
  }
  if (tone === "danger") {
    return "bg-danger/10 text-danger";
  }
  return "bg-surface text-muted";
}

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
