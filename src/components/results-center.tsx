"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";

type JsonRecord = Record<string, unknown>;
type LoadState = "loading" | "ready" | "error";
type Tone = "neutral" | "success" | "warning" | "danger";

type ResultsState = {
  session?: JsonRecord;
  runs?: JsonRecord;
  workflows?: JsonRecord;
  approvals?: JsonRecord;
  evaluations?: JsonRecord;
  release?: JsonRecord;
  events?: JsonRecord;
};

type PrimaryResult = {
  kind: "agent" | "workflow" | "approval" | "empty";
  title: string;
  status: string;
  body: string;
  meta: string;
  href: string;
  tone: Tone;
};

export function ResultsCenter() {
  const [data, setData] = useState<ResultsState>({});
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [lastRefresh, setLastRefresh] = useState<string>();

  async function load() {
    setState("loading");
    setError(undefined);

    try {
      const session = asRecord(await readJson("/api/auth/session"));
      if (Boolean(session.authEnabled) && !Boolean(session.authenticated)) {
        setData({ session });
        setState("ready");
        setLastRefresh(new Date().toLocaleTimeString());
        return;
      }

      const role = sessionRole(session);
      const canManageWorkflow = hasRole(role, ["operator", "admin", "system"]);
      const canReadSecurity = hasRole(role, ["admin", "system"]);
      const unavailableForRole = { error: "Operator or admin role required.", items: [], runs: [], events: [] };
      const securityUnavailable = { error: "Admin role required.", report: undefined, events: [] };

      const [runs, workflows, approvals, evaluations, release, events] = await Promise.all([
        readJson("/api/runs?limit=10").catch((resourceError) => ({ error: refreshMessage(resourceError), runs: [] })),
        readJson("/api/workflows?limit=12").catch((resourceError) => ({ error: refreshMessage(resourceError), runs: [] })),
        canManageWorkflow
          ? readJson("/api/approvals?limit=12").catch((resourceError) => ({ error: refreshMessage(resourceError), items: [] }))
          : Promise.resolve(unavailableForRole),
        readJson("/api/evaluations?limit=8").catch((resourceError) => ({ error: refreshMessage(resourceError), runs: [] })),
        canReadSecurity
          ? readJson("/api/release/evidence").catch((resourceError) => ({ error: refreshMessage(resourceError) }))
          : Promise.resolve(securityUnavailable),
        canReadSecurity
          ? readJson("/api/observability?limit=12").catch((resourceError) => ({ error: refreshMessage(resourceError), events: [] }))
          : Promise.resolve(securityUnavailable),
      ]);

      setData({
        session,
        runs: asRecord(runs),
        workflows: asRecord(workflows),
        approvals: asRecord(approvals),
        evaluations: asRecord(evaluations),
        release: asRecord(release),
        events: asRecord(events),
      });
      setState("ready");
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Results are unavailable.");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const agentRuns = arrayPath(data, "runs.runs");
  const workflowRuns = arrayPath(data, "workflows.runs");
  const approvalItems = arrayPath(data, "approvals.items");
  const evaluationRuns = arrayPath(data, "evaluations.runs");
  const runtimeEvents = arrayPath(data, "events.events");
  const primaryResult = useMemo(
    () => choosePrimaryResult(agentRuns, workflowRuns, approvalItems),
    [agentRuns, workflowRuns, approvalItems],
  );
  const signedIn = !Boolean(readPath(data, "session.authEnabled")) || Boolean(readPath(data, "session.authenticated"));

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <FileText size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Last step</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">Results</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">
              This is the final place to look after a run. A completed item is a result. A waiting approval, failed workflow, or blocked gate means the work has not produced a final result yet.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} className="action-button">
              {state === "loading" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              Refresh
            </button>
            <Link href="/app/command" className="primary-button">
              Start run
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-5">
          <Metric label="Agent answers" value={agentRuns.filter((run) => stringValue(run.status) === "completed").length.toString()} tone="success" />
          <Metric label="Workflows" value={workflowRuns.length.toString()} tone="neutral" />
          <Metric label="Waiting approval" value={approvalItems.length.toString()} tone={approvalItems.length ? "warning" : "success"} />
          <Metric label="Release gate" value={stringPath(data, "release.report.releaseGate.status", "not loaded")} tone={toneForStatus(readPath(data, "release.report.releaseGate.status"))} />
          <Metric label="Updated" value={lastRefresh || "..."} tone="neutral" />
        </div>
      </section>

      {!signedIn && state === "ready" ? (
        <section className="mt-4 rounded-lg border border-warning/45 bg-warning/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Sign in to see production results</p>
              <p className="mt-1 text-sm text-muted">Runs, workflows, approvals, and release evidence require an authenticated operator session.</p>
            </div>
            <Link href="/login" className="primary-button">Sign in</Link>
          </div>
        </section>
      ) : null}

      {state === "error" ? (
        <section className="mt-4 rounded-lg border border-danger/45 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </section>
      ) : null}

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <PrimaryResultCard result={primaryResult} />

        <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">What to do next</h2>
              <p className="mt-1 text-xs leading-5 text-muted">Use status to decide whether you are done or blocked.</p>
            </div>
            <StatusPill label={primaryResult.status} tone={primaryResult.tone} />
          </div>
          <div className="grid gap-3">
            <NextStepRow
              icon={CheckCircle2}
              title="Completed"
              body="Read the output here, then use the evidence links below if you need audit details."
              active={primaryResult.tone === "success"}
            />
            <NextStepRow
              icon={AlertTriangle}
              title="Waiting approval"
              body="Open Approvals, decide the gate, then return here after the workflow advances."
              active={primaryResult.status === "waiting_approval" || approvalItems.length > 0}
            />
            <NextStepRow
              icon={TerminalSquare}
              title="No output yet"
              body="Start or continue a run from Run Agent. Results will appear here after execution."
              active={primaryResult.kind === "empty"}
            />
          </div>
        </section>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ResultPanel title="Latest workflow outcomes" description="Durable runs, current step, and final report when available.">
          <ResultRows
            rows={workflowRuns.map((run) => ({
              title: stringValue(run.goal, "Workflow"),
              status: stringValue(run.status, "unknown"),
              meta: workflowMeta(run),
              body: resultPreview(readPath(run, "result.report") || run.error),
            }))}
            empty="No workflow results found."
            icon={Workflow}
          />
        </ResultPanel>

        <ResultPanel title="Agent answers" description="Direct agent runs and their returned responses.">
          <ResultRows
            rows={agentRuns.map((run) => ({
              title: stringValue(run.prompt, "Agent run"),
              status: stringValue(run.status, "unknown"),
              meta: `${stringValue(run.mode, "agent")} / ${formatTime(stringValue(run.completedAt || run.startedAt))}`,
              body: resultPreview(run.response || run.error),
            }))}
            empty="No agent answers found."
            icon={TerminalSquare}
          />
        </ResultPanel>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <ResultPanel title="Blocked before result" description="These items must be approved, rejected, or resolved before the outcome is final.">
          <ResultRows
            rows={approvalItems.map((item) => ({
              title: stringValue(item.title, "Approval"),
              status: stringValue(item.status, "waiting"),
              meta: `${stringValue(item.kind, "approval")} / risk ${stringValue(item.riskLevel, "n/a")}`,
              body: resultPreview(item.reason || readPath(item, "record.error")),
              href: "/app/approvals",
            }))}
            empty="No approval blockers are waiting."
            icon={ShieldCheck}
          />
        </ResultPanel>

        <ResultPanel title="Evidence trail" description="Release, evaluation, and runtime evidence used to trust the result.">
          <div className="grid gap-3 md:grid-cols-3">
            <EvidenceBox
              label="Release"
              value={stringPath(data, "release.report.releaseGate.status", "not loaded")}
              tone={toneForStatus(readPath(data, "release.report.releaseGate.status"))}
              href="/app/evaluations"
            />
            <EvidenceBox
              label="Evaluations"
              value={`${evaluationRuns.length} runs`}
              tone={evaluationRuns.some((run) => stringValue(run.status) === "failed") ? "danger" : "success"}
              href="/app/evaluations"
            />
            <EvidenceBox
              label="Runtime"
              value={`${runtimeEvents.length} events`}
              tone={runtimeEvents.some((event) => stringValue(event.level) === "error") ? "danger" : "neutral"}
              href="/app/observability"
            />
          </div>
          <div className="mt-4">
            <ResultRows
              rows={evaluationRuns.slice(0, 4).map((run) => ({
                title: stringValue(run.suite, "Evaluation suite"),
                status: stringValue(run.status, "unknown"),
                meta: formatTime(stringValue(run.completedAt || run.startedAt || run.createdAt)),
                body: `Passed ${stringPath(run, "summary.passed", "0")} of ${stringPath(run, "summary.total", "0")} checks.`,
                href: "/app/evaluations",
              }))}
              empty="No evaluation runs loaded."
              icon={CheckCircle2}
            />
          </div>
        </ResultPanel>
      </section>
    </div>
  );
}

function PrimaryResultCard({ result }: { result: PrimaryResult }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Current result</p>
          <h2 className="mt-2 text-lg font-semibold">{result.title}</h2>
          <p className="mt-1 text-xs text-muted">{result.meta}</p>
        </div>
        <StatusPill label={result.status} tone={result.tone} />
      </div>
      <div className="min-h-56 overflow-auto rounded-md border border-line bg-background p-4 text-sm leading-6 text-muted">
        {result.body}
      </div>
      <Link href={result.href} className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised">
        Open source workspace
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </section>
  );
}

function NextStepRow({ icon: Icon, title, body, active }: { icon: typeof FileText; title: string; body: string; active: boolean }) {
  return (
    <div className={clsx("rounded-md border p-3", active ? "border-primary/45 bg-primary/10" : "border-line bg-background")}>
      <div className="flex items-start gap-3">
        <span className={clsx("grid size-8 place-items-center rounded-md", active ? "bg-primary text-primary-ink" : "bg-surface text-muted")}>
          <Icon size={15} aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ResultRows({
  rows,
  empty,
  icon: Icon,
}: {
  rows: Array<{ title: string; status: string; meta: string; body: string; href?: string }>;
  empty: string;
  icon: typeof FileText;
}) {
  if (!rows.length) {
    return <div className="rounded-md border border-dashed border-line bg-background p-4 text-sm text-muted">{empty}</div>;
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-background">
      {rows.slice(0, 8).map((row, index) => {
        const content = (
          <div className="flex items-start gap-3 p-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-surface text-primary">
              <Icon size={15} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{row.title}</p>
                  <p className="mt-1 truncate text-xs text-muted">{row.meta}</p>
                </div>
                <span className={clsx("shrink-0 rounded-md px-2 py-1 font-mono text-xs", pillTone(toneForStatus(row.status)))}>{row.status}</span>
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{row.body}</p>
            </div>
          </div>
        );
        return row.href ? (
          <Link key={`${row.title}-${index}`} href={row.href} className="block transition hover:bg-surface-raised">
            {content}
          </Link>
        ) : (
          <div key={`${row.title}-${index}`}>{content}</div>
        );
      })}
    </div>
  );
}

function EvidenceBox({ label, value, tone, href }: { label: string; value: string; tone: Tone; href: string }) {
  return (
    <Link href={href} className="rounded-md border border-line bg-background p-3 transition hover:bg-surface-raised">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx("mt-3 font-mono text-sm", textTone(tone))}>{value}</p>
    </Link>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={clsx("inline-flex h-10 items-center rounded-md px-3 font-mono text-sm", pillTone(tone))}>{label}</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="bg-background p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx("mt-3 font-mono text-xl", textTone(tone))}>{value}</p>
    </div>
  );
}

function choosePrimaryResult(agentRuns: JsonRecord[], workflowRuns: JsonRecord[], approvalItems: JsonRecord[]): PrimaryResult {
  const completedAgent = agentRuns.find((run) => stringValue(run.status) === "completed" && stringValue(run.response));
  if (completedAgent) {
    return {
      kind: "agent",
      title: stringValue(completedAgent.prompt, "Agent result"),
      status: "completed",
      body: resultPreview(completedAgent.response, "The agent completed, but no response text was stored."),
      meta: `${stringValue(completedAgent.mode, "agent")} / ${formatTime(stringValue(completedAgent.completedAt || completedAgent.startedAt))}`,
      href: "/app/command",
      tone: "success",
    };
  }

  const completedWorkflow = workflowRuns.find((run) => stringValue(run.status) === "completed" && stringValue(readPath(run, "result.report")));
  if (completedWorkflow) {
    return {
      kind: "workflow",
      title: stringValue(completedWorkflow.goal, "Workflow result"),
      status: "completed",
      body: resultPreview(readPath(completedWorkflow, "result.report"), "The workflow completed, but no report was stored."),
      meta: `workflow / ${formatTime(stringValue(completedWorkflow.completedAt || completedWorkflow.updatedAt))}`,
      href: "/app/workflows",
      tone: "success",
    };
  }

  const approval = approvalItems[0];
  if (approval) {
    return {
      kind: "approval",
      title: stringValue(approval.title, "Approval required"),
      status: stringValue(approval.status, "waiting_approval"),
      body: resultPreview(approval.reason, "This work is paused until an operator approves or rejects the gate."),
      meta: `${stringValue(approval.kind, "approval")} / risk ${stringValue(approval.riskLevel, "n/a")}`,
      href: "/app/approvals",
      tone: "warning",
    };
  }

  const latestWorkflow = workflowRuns[0];
  if (latestWorkflow) {
    return {
      kind: "workflow",
      title: stringValue(latestWorkflow.goal, "Workflow"),
      status: stringValue(latestWorkflow.status, "unknown"),
      body: resultPreview(readPath(latestWorkflow, "result.report") || latestWorkflow.error, "This workflow has not produced a final report yet."),
      meta: workflowMeta(latestWorkflow),
      href: "/app/workflows",
      tone: toneForStatus(latestWorkflow.status),
    };
  }

  return {
    kind: "empty",
    title: "No result yet",
    status: "empty",
    body: "Start at Run Agent. After an agent run or workflow produces output, the latest result appears here.",
    meta: "Home -> Run Agent -> Results",
    href: "/app/command",
    tone: "neutral",
  };
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
    const record = asRecord(body);
    throw new HttpError(response.status, stringValue(record.message || record.error, `${path} returned ${response.status}`));
  }
  return body;
}

function refreshMessage(error: unknown) {
  return error instanceof Error ? error.message : "Resource unavailable.";
}

function sessionRole(session: JsonRecord) {
  return stringValue(readPath(session, "context.role") || readPath(session, "membership.role"), "viewer");
}

function hasRole(role: string, allowed: string[]) {
  return allowed.includes(role);
}

function workflowMeta(run: JsonRecord) {
  return `${stringValue(run.currentStep, "complete")} / ${formatTime(stringValue(run.completedAt || run.updatedAt || run.createdAt))}`;
}

function resultPreview(value: unknown, fallback = "No result text available.") {
  const text = stringValue(value, fallback).trim();
  if (text.length <= 620) {
    return text;
  }
  return `${text.slice(0, 620)}...`;
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

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function toneForStatus(value: unknown): Tone {
  const text = stringValue(value).toLowerCase();
  if (["healthy", "passed", "success", "completed", "executed", "active", "allow", "approved", "ready", "info"].includes(text)) {
    return "success";
  }
  if (["warn", "warning", "waiting_approval", "queued", "paused", "pending", "degraded", "dry_run", "empty"].includes(text)) {
    return "warning";
  }
  if (["error", "failed", "blocked", "deny", "unhealthy", "rejected", "open"].includes(text)) {
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
    return value || "not timed";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
