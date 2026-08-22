"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Square,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { clsx } from "clsx";
import {
  buildResultTimeline,
  formatResultTime,
  toneForResultStatus,
  type ResultTimelineItem,
} from "@/components/results-utils";
import { useLiveRefresh } from "@/components/use-live-refresh";

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
  key?: string;
  kind: "agent" | "workflow" | "approval" | "empty" | "unknown";
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
  const [selectedResultKey, setSelectedResultKey] = useState<string>();
  const [cancelingRunId, setCancelingRunId] = useState<string>();
  const loadVersionRef = useRef(0);

  async function load() {
    const loadVersion = ++loadVersionRef.current;
    setState("loading");
    setError(undefined);

    try {
      const session = asRecord(await readJson("/api/auth/session"));
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      if (Boolean(session.authEnabled) && !Boolean(session.authenticated)) {
        setData({ session });
        setState("ready");
        setLastRefresh(new Date().toLocaleTimeString());
        return;
      }

      const role = sessionRole(session);
      const requestedResultKey =
        new URL(window.location.href).searchParams.get("run") || undefined;
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
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      const runsPayload = asRecord(runs);
      const workflowsPayload = asRecord(workflows);
      if (requestedResultKey?.startsWith("agent:")) {
        const runId = requestedResultKey.slice("agent:".length);
        if (
          runId &&
          !arrayPath(runsPayload, "runs").some(
            (run) => stringValue(run.id) === runId,
          )
        ) {
          const direct = asRecord(
            await readJson(`/api/runs/${encodeURIComponent(runId)}`).catch(
              () => ({}),
            ),
          );
          const directRun = asRecord(direct.run);
          if (stringValue(directRun.id) === runId) {
            runsPayload.runs = [directRun, ...arrayPath(runsPayload, "runs")];
          }
        }
      }
      if (requestedResultKey?.startsWith("workflow:")) {
        const runId = requestedResultKey.slice("workflow:".length);
        if (
          runId &&
          !arrayPath(workflowsPayload, "runs").some(
            (run) => stringValue(run.id) === runId,
          )
        ) {
          const direct = asRecord(
            await readJson(
              `/api/workflows/${encodeURIComponent(runId)}`,
            ).catch(() => ({})),
          );
          const directRun = asRecord(direct.run);
          if (stringValue(directRun.id) === runId) {
            workflowsPayload.runs = [
              directRun,
              ...arrayPath(workflowsPayload, "runs"),
            ];
          }
        }
      }
      if (loadVersion !== loadVersionRef.current) {
        return;
      }

      setData({
        session,
        runs: runsPayload,
        workflows: workflowsPayload,
        approvals: asRecord(approvals),
        evaluations: asRecord(evaluations),
        release: asRecord(release),
        events: asRecord(events),
      });
      setState("ready");
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (loadError) {
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
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

  useEffect(() => {
    const readSelection = () => {
      setSelectedResultKey(
        new URL(window.location.href).searchParams.get("run") || undefined,
      );
    };
    readSelection();
    window.addEventListener("popstate", readSelection);
    return () => window.removeEventListener("popstate", readSelection);
  }, []);

  const agentRuns = arrayPath(data, "runs.runs");
  const workflowRuns = arrayPath(data, "workflows.runs");
  const approvalItems = arrayPath(data, "approvals.items");
  const hasActiveWork = [...agentRuns, ...workflowRuns].some((run) =>
    ["queued", "running", "waiting_approval", "resuming", "paused"].includes(
      stringValue(run.status).toLowerCase(),
    ),
  );
  useLiveRefresh({
    enabled: state !== "error",
    onRefresh: load,
    pollIntervalMs: hasActiveWork ? 8_000 : undefined,
  });
  const evaluationRuns = arrayPath(data, "evaluations.runs");
  const runtimeEvents = arrayPath(data, "events.events");
  const resultTimeline = useMemo(
    () => buildResultTimeline({ agentRuns, workflowRuns, approvalItems }),
    [agentRuns, approvalItems, workflowRuns],
  );
  const resultSourceError = Boolean(resourceError(data.runs) || resourceError(data.workflows) || resourceError(data.approvals));
  const primaryResult = useMemo(
    () => {
      const selected = resultTimeline.find(
        (item) => item.key === selectedResultKey,
      );
      if (selected) {
        return selected;
      }
      return selectedResultKey
        ? unavailableSelectedResult(selectedResultKey)
        : choosePrimaryResult(resultTimeline, resultSourceError);
    },
    [resultSourceError, resultTimeline, selectedResultKey],
  );
  const signedIn = !Boolean(readPath(data, "session.authEnabled")) || Boolean(readPath(data, "session.authenticated"));
  const hasLoadedData = Boolean(data.runs || data.workflows || data.approvals || data.evaluations || data.release || data.events);
  const sourceErrors = [
    ["Agent runs", resourceError(data.runs)],
    ["Workflows", resourceError(data.workflows)],
    ["Inbox", resourceError(data.approvals)],
    ["Evaluations", resourceError(data.evaluations)],
    ["Release evidence", resourceError(data.release)],
    ["Runtime events", resourceError(data.events)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  function selectResult(key: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("run", key);
    window.history.pushState({}, "", url);
    setSelectedResultKey(key);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function cancelAgentResult(result: PrimaryResult) {
    const key = result.key || selectedResultKey;
    if (!key?.startsWith("agent:")) {
      return;
    }
    const runId = key.slice("agent:".length);
    setCancelingRunId(runId);
    setError(undefined);
    try {
      await readJson(`/api/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });
      await load();
    } catch (cancelError) {
      setError(refreshMessage(cancelError));
    } finally {
      setCancelingRunId(undefined);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8" aria-busy={state === "loading"} data-testid="results-workspace">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
                <FileText size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold text-primary">Results</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">Results</h1>
              </div>
            </div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-muted">
              Completed output appears here with workflow, approval, evaluation, and runtime evidence. Unknown or unavailable sources stay visible instead of being counted as zero.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void load()} disabled={state === "loading"} className="action-button">
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
          <Metric
            label="Agent answers"
            value={resourceMetric(state, signedIn, data.runs, agentRuns.filter((run) => stringValue(run.status) === "completed").length.toString())}
            tone={resourceTone(data.runs, "success")}
          />
          <Metric label="Workflows" value={resourceMetric(state, signedIn, data.workflows, workflowRuns.length.toString())} tone="neutral" />
          <Metric
            label="Waiting approval"
            value={resourceMetric(state, signedIn, data.approvals, approvalItems.length.toString())}
            tone={resourceTone(data.approvals, approvalItems.length ? "warning" : "success")}
          />
          <Metric
            label="Release gate"
            value={resourceMetric(state, signedIn, data.release, stringPath(data, "release.report.releaseGate.status", "Unknown"))}
            tone={resourceTone(data.release, toneForStatus(readPath(data, "release.report.releaseGate.status")))}
          />
          <Metric label="Updated" value={lastRefresh || (state === "loading" ? "Loading" : "Unknown")} tone="neutral" />
        </div>
      </section>

      {state === "loading" && hasLoadedData ? (
        <p className="mt-4 rounded-md border border-info/40 bg-info/10 px-4 py-3 text-sm" role="status">
          Refreshing results. The last loaded values remain visible until the request finishes.
        </p>
      ) : null}

      {state === "loading" && !hasLoadedData ? (
        <section className="mt-4 rounded-lg border border-line bg-surface p-6" role="status" aria-live="polite">
          <div className="h-4 w-40 animate-pulse rounded bg-surface-raised" />
          <div className="mt-4 h-24 animate-pulse rounded bg-surface-raised" />
          <p className="mt-4 text-sm text-muted">Loading results and evidence.</p>
        </section>
      ) : null}

      {sourceErrors.length && signedIn ? (
        <section className="mt-4 rounded-lg border border-warning/45 bg-warning/10 p-4" aria-labelledby="results-source-errors" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id="results-source-errors" className="text-sm font-semibold">Some evidence is unavailable</h2>
              <ul className="mt-2 space-y-1 text-sm leading-6 text-muted">
                {sourceErrors.map(([label, message]) => <li key={label}><strong className="text-foreground">{label}:</strong> {message}</li>)}
              </ul>
              <button type="button" onClick={() => void load()} className="action-button mt-3">Retry unavailable sources</button>
            </div>
          </div>
        </section>
      ) : null}

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
        <section className="mt-4 rounded-lg border border-danger/45 bg-danger/10 p-4" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold">Results could not be loaded</h2>
              <p className="mt-1 text-sm leading-6 text-muted">{error}</p>
              <button type="button" onClick={() => void load()} className="action-button mt-3">Retry results</button>
            </div>
          </div>
        </section>
      ) : null}

      {signedIn && state !== "error" && (state !== "loading" || hasLoadedData) ? (
        <>
      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <PrimaryResultCard
          result={primaryResult}
          canceling={Boolean(cancelingRunId)}
          onCancel={() => void cancelAgentResult(primaryResult)}
        />

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
              icon={RefreshCw}
              title="Active"
              body="Open Activity to follow progress. A running or queued item is not a completed result."
              active={["running", "queued", "pending"].includes(primaryResult.status)}
            />
            <NextStepRow
              icon={AlertTriangle}
              title="Waiting approval"
              body="Open Inbox, decide the request, then return after the workflow advances."
              active={primaryResult.status === "waiting_approval" || approvalItems.length > 0}
            />
            <NextStepRow
              icon={AlertTriangle}
              title="Failed or blocked"
              body="Open the source workspace, inspect the recorded error, and retry only after the cause is understood."
              active={["failed", "blocked", "rejected"].includes(primaryResult.status)}
            />
            <NextStepRow
              icon={TerminalSquare}
              title="Canceled"
              body="This run was stopped before completion. Start it again only if you still need the result."
              active={["canceled", "cancelled"].includes(primaryResult.status)}
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
              key: `workflow:${stringValue(run.id)}`,
              title: stringValue(run.goal, "Workflow"),
              status: stringValue(run.status, "unknown"),
              meta: workflowMeta(run),
              body: resultPreview(readPath(run, "result.report") || run.error),
            }))}
            empty="No workflow results found."
            icon={Workflow}
            onSelect={selectResult}
          />
        </ResultPanel>

        <ResultPanel title="Agent answers" description="Direct agent runs and their returned responses.">
          <ResultRows
            rows={agentRuns.map((run) => ({
              key: `agent:${stringValue(run.id)}`,
              title: stringValue(run.prompt, "Agent run"),
              status: stringValue(run.status, "unknown"),
              meta: `${stringValue(run.mode, "agent")} / ${formatResultTime(stringValue(run.completedAt || run.startedAt))}`,
              body: resultPreview(run.response || run.error),
            }))}
            empty="No agent answers found."
            icon={TerminalSquare}
            onSelect={selectResult}
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
              value={resourceMetric(state, signedIn, data.release, stringPath(data, "release.report.releaseGate.status", "Unknown"))}
              tone={resourceError(data.release) ? "neutral" : toneForStatus(readPath(data, "release.report.releaseGate.status"))}
              href="/app/evaluations"
            />
            <EvidenceBox
              label="Evaluations"
              value={resourceMetric(state, signedIn, data.evaluations, `${evaluationRuns.length} runs`)}
              tone={resourceError(data.evaluations) ? "neutral" : evaluationRuns.some((run) => stringValue(run.status) === "failed") ? "danger" : evaluationRuns.length ? "success" : "neutral"}
              href="/app/evaluations"
            />
            <EvidenceBox
              label="Runtime"
              value={resourceMetric(state, signedIn, data.events, `${runtimeEvents.length} events`)}
              tone={resourceError(data.events) ? "neutral" : runtimeEvents.some((event) => stringValue(event.level) === "error") ? "danger" : "neutral"}
              href="/app/observability"
            />
          </div>
          <div className="mt-4">
            <ResultRows
              rows={evaluationRuns.slice(0, 4).map((run) => ({
                title: stringValue(run.suite, "Evaluation suite"),
                status: stringValue(run.status, "unknown"),
                meta: formatResultTime(stringValue(run.completedAt || run.startedAt || run.createdAt)),
                body: `Passed ${stringPath(run, "summary.passed", "0")} of ${stringPath(run, "summary.total", "0")} checks.`,
                href: "/app/evaluations",
              }))}
              empty="No evaluation runs loaded."
              icon={CheckCircle2}
            />
          </div>
        </ResultPanel>
      </section>
        </>
      ) : null}
    </div>
  );
}

function PrimaryResultCard({
  result,
  canceling,
  onCancel,
}: {
  result: PrimaryResult;
  canceling: boolean;
  onCancel: () => void;
}) {
  const canCancel =
    result.kind === "agent" &&
    ["running", "waiting_approval", "resuming"].includes(
      result.status.toLowerCase(),
    );
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
      <div className="min-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-background p-4 text-sm leading-6 text-muted">
        {result.body}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={result.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-background px-3 text-sm font-semibold transition hover:bg-surface-raised">
          {result.href.startsWith("/app/results?")
            ? "Permanent link to this result"
            : "Open source workspace"}
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
        {canCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={canceling}
            className="action-button border-danger/50 text-danger"
          >
            {canceling ? (
              <Loader2
                size={14}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Square size={13} aria-hidden="true" />
            )}
            {canceling ? "Canceling run" : "Cancel run"}
          </button>
        ) : null}
      </div>
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
          {active ? <span className="mt-1 inline-flex text-xs font-semibold text-primary">Current state</span> : null}
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
  onSelect,
}: {
  rows: Array<{
    key?: string;
    title: string;
    status: string;
    meta: string;
    body: string;
    href?: string;
  }>;
  empty: string;
  icon: typeof FileText;
  onSelect?: (key: string) => void;
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
        return row.key && onSelect ? (
          <button
            key={row.key}
            type="button"
            onClick={() => onSelect(row.key!)}
            className="block w-full text-left transition hover:bg-surface-raised"
          >
            {content}
          </button>
        ) : row.href ? (
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

function unavailableSelectedResult(key: string): PrimaryResult {
  const [kind, id] = key.split(":", 2);
  return {
    kind: "unknown",
    title: "Linked result is unavailable",
    status: "unavailable",
    body:
      "This result could not be loaded. It may have expired under the retention policy, belong to another workspace, or use an invalid link.",
    meta: `${kind || "result"} ${id || "unknown"}`,
    href: "/app/results",
    tone: "neutral",
  };
}

function choosePrimaryResult(timeline: ResultTimelineItem[], sourceError: boolean): PrimaryResult {
  const latest = timeline[0];
  if (latest) {
    return latest;
  }
  if (sourceError) {
    return {
      kind: "unknown",
      title: "Result state unavailable",
      status: "unknown",
      body: "One or more result sources could not be loaded. Retry the unavailable sources before treating this workspace as empty.",
      meta: "The latest state could not be verified.",
      href: "/app",
      tone: "neutral",
    };
  }
  return {
    kind: "empty",
    title: "No result yet",
    status: "empty",
    body: "Start in Work. The latest run, workflow, or approval state will appear here after execution begins.",
    meta: "Work / Activity / Inbox / Results",
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

async function readJson(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
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
  return `${stringValue(run.currentStep, "complete")} / ${formatResultTime(stringValue(run.completedAt || run.updatedAt || run.createdAt))}`;
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
  return toneForResultStatus(value);
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

function resourceError(value: unknown) {
  const record = asRecord(value);
  return stringValue(record.error || record.message);
}

function resourceTone(value: unknown, tone: Tone): Tone {
  return value && !resourceError(value) ? tone : "neutral";
}

function resourceMetric(
  state: LoadState,
  signedIn: boolean,
  resource: unknown,
  value: string,
) {
  if (!signedIn) {
    return "Sign in";
  }
  if (resourceError(resource)) {
    return "Unavailable";
  }
  if (!resource) {
    return state === "loading" ? "Loading" : "Unknown";
  }
  return value;
}
