"use client";

import Link from "next/link";
import { ResearchPanel, researchViewFromWorkflow } from "@/components/command/research-panel";
import dynamic from "next/dynamic";
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
import {
  canPerform,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { useLiveRefresh } from "@/components/use-live-refresh";
import { GeneratedArtifactsShelf } from "@/components/generated-artifacts-shelf";
import { WorkspaceLibrary } from "@/components/workspace-library";
import styles from "./results-center.module.css";

const ResultReport = dynamic(() => import("@/components/agent-runs-workspace")
  .then((module) => module.ConversationMessageContent));

const RESULT_LIBRARY_KINDS = [
  "image",
  "transcript",
] as const;

type JsonRecord = Record<string, unknown>;
type LoadState = "loading" | "ready" | "error";
type Tone = "neutral" | "success" | "warning" | "danger";

type ResultsState = {
  runs?: JsonRecord;
  workflows?: JsonRecord;
  approvals?: JsonRecord;
  evaluations?: JsonRecord;
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

export function ResultsCenter({ embedded = false }: { embedded?: boolean }) {
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [data, setData] = useState<ResultsState>({});
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [lastRefresh, setLastRefresh] = useState<string>();
  const [selectedResultKey, setSelectedResultKey] = useState<string>();
  const [cancelingRunId, setCancelingRunId] = useState<string>();
  const loadVersionRef = useRef(0);
  const activeLoadRef = useRef<AbortController | null>(null);

  async function load() {
    if (sessionStatus !== "ready" || !session) {
      return;
    }
    const loadVersion = ++loadVersionRef.current;
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    setState("loading");
    setError(undefined);

    try {
      if (Boolean(session.authEnabled) && !Boolean(session.authenticated)) {
        setData({});
        setState("ready");
        setLastRefresh(new Date().toLocaleTimeString());
        return;
      }

      const requestedResultKey =
        new URL(window.location.href).searchParams.get("run") || undefined;
      const summaryRequest = readJson(
        "/api/workspace-summary?limit=12&approvalLimit=12",
        { signal: controller.signal },
      ).then(async (payload) => {
        const summary = asRecord(payload.summary);
        const runsPayload = workspaceSourcePayload(summary, "runs", "runs");
        const workflowsPayload = workspaceSourcePayload(
          summary,
          "workflows",
          "runs",
        );
        const approvalsPayload = canPerform(role, "manage.workflow")
          ? workspaceSourcePayload(summary, "approvals", "items")
          : { error: "Operator or admin role required.", items: [] };
        await loadSelectedResult(
          requestedResultKey,
          runsPayload,
          workflowsPayload,
          controller.signal,
        );
        if (loadVersion !== loadVersionRef.current || controller.signal.aborted) {
          return;
        }
        setData((current) => ({
          ...current,
          runs: retainStalePayload(current.runs, runsPayload, "runs"),
          workflows: retainStalePayload(
            current.workflows,
            workflowsPayload,
            "runs",
          ),
          approvals: retainStalePayload(
            current.approvals,
            approvalsPayload,
            "items",
          ),
        }));
      });
      const evaluationsRequest = readJson("/api/evaluations?limit=8", {
        signal: controller.signal,
      })
        .then((evaluations) => {
          if (loadVersion !== loadVersionRef.current || controller.signal.aborted) {
            return;
          }
          setData((current) => ({
            ...current,
            evaluations: asRecord(evaluations),
          }));
        })
        .catch((resourceError) => {
          if (controller.signal.aborted || loadVersion !== loadVersionRef.current) {
            return;
          }
          setData((current) => ({
            ...current,
            evaluations: retainStalePayload(
              current.evaluations,
              { error: refreshMessage(resourceError) },
              "runs",
            ),
          }));
        });

      const [summaryResult] = await Promise.allSettled([
        summaryRequest,
        evaluationsRequest,
      ]);
      if (loadVersion !== loadVersionRef.current || controller.signal.aborted) {
        return;
      }
      if (summaryResult.status === "rejected") {
        const message = refreshMessage(summaryResult.reason);
        setData((current) => ({
          ...current,
          runs: retainStalePayload(current.runs, { error: message }, "runs"),
          workflows: retainStalePayload(
            current.workflows,
            { error: message },
            "runs",
          ),
          approvals: retainStalePayload(
            current.approvals,
            { error: message },
            "items",
          ),
        }));
      }
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
      if (sessionStatus === "ready") {
        void load();
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // Session changes are the only automatic refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, role]);

  useEffect(
    () => () => {
      activeLoadRef.current?.abort();
    },
    [],
  );

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

  useEffect(() => {
    if (!selectedResultKey) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // A selected result needs its exact saved report, including interrupted drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedResultKey]);

  const agentRuns = arrayPath(data, "runs.runs");
  const workflowRuns = arrayPath(data, "workflows.runs");
  const approvalItems = arrayPath(data, "approvals.items");
  const hasActiveWork = [...agentRuns, ...workflowRuns].some((run) =>
    ["queued", "running", "waiting_approval", "resuming", "paused"].includes(
      stringValue(run.status).toLowerCase(),
    ),
  );
  useLiveRefresh({
    enabled: state !== "error" && sessionStatus === "ready",
    onRefresh: load,
    pollIntervalMs: hasActiveWork ? 8_000 : undefined,
  });
  const evaluationRuns = arrayPath(data, "evaluations.runs");
  const resultTimeline = useMemo(
    () => withWorkflowOutcomeMetadata(
      buildResultTimeline({ agentRuns, workflowRuns, approvalItems }),
      workflowRuns,
    ),
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
        ? unavailableSelectedResult()
        : choosePrimaryResult(resultTimeline, resultSourceError);
    },
    [resultSourceError, resultTimeline, selectedResultKey],
  );
  const signedIn = !session?.authEnabled || Boolean(session.authenticated);
  const hasLoadedData = Boolean(data.runs || data.workflows || data.approvals || data.evaluations);
  const sourceErrors = [
    ["Agent runs", resourceError(data.runs)],
    ["Workflows", resourceError(data.workflows)],
    ["Approvals", resourceError(data.approvals)],
    ["Evaluations", resourceError(data.evaluations)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  function selectResult(key: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("run", key);
    window.history.pushState({}, "", url);
    setSelectedResultKey(key);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "instant" : "smooth" });
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
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      await load();
    } catch (cancelError) {
      setError(refreshMessage(cancelError));
    } finally {
      setCancelingRunId(undefined);
    }
  }

  return (
    <div className={clsx(styles.shell, embedded && styles.embedded)} aria-busy={state === "loading"} data-testid="results-workspace">
      <header className={styles.header}>
        <div className={styles.introduction}>
          <h2>Results</h2>
          <p>Review outputs, their current status, and the evidence behind them.</p>
          <p className={styles.refreshTime}>
            {lastRefresh ? `Updated ${lastRefresh}` : state === "loading" ? "Loading results" : "Update time unknown"}
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={() => void load()} disabled={state === "loading"} className={styles.button}>
            {state === "loading" ? <Loader2 size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            Refresh
          </button>
          <Link href="/app/command" className={clsx(styles.button, styles.primaryButton)}>
            Start task
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {state === "loading" && hasLoadedData ? (
        <p className={styles.refreshNotice} role="status">
          Refreshing results. The last loaded values remain visible until the request finishes.
        </p>
      ) : null}

      {state === "loading" && !hasLoadedData ? (
        <section className={styles.loading} role="status" aria-live="polite">
          <div className={styles.loadingTitle} aria-hidden="true" />
          <div className={styles.loadingBody} aria-hidden="true" />
          <p>Loading results and evidence.</p>
        </section>
      ) : null}

      {sourceErrors.length && signedIn ? (
        <section className={clsx(styles.notice, styles.warningNotice)} aria-labelledby="results-source-errors" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <h2 id="results-source-errors">Some evidence is unavailable</h2>
            <ul className={styles.sourceErrors}>
              {sourceErrors.map(([label, message]) => <li key={label}><strong>{label}:</strong> {message}</li>)}
            </ul>
            <button type="button" onClick={() => void load()} className={styles.button}>Retry unavailable sources</button>
          </div>
        </section>
      ) : null}

      {!signedIn && state === "ready" ? (
        <section className={clsx(styles.notice, styles.warningNotice)}>
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <h2>Sign in to see production results</h2>
            <p>Runs, workflows, approvals, and release evidence require an authenticated operator session.</p>
            <Link href="/login" className={clsx(styles.button, styles.primaryButton)}>Sign in</Link>
          </div>
        </section>
      ) : null}

      {state === "error" ? (
        <section className={clsx(styles.notice, styles.errorNotice)} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <h2>Results could not be loaded</h2>
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className={styles.button}>Retry results</button>
          </div>
        </section>
      ) : null}

      {signedIn && state !== "error" && (state !== "loading" || hasLoadedData) ? (
        <>
          <div className={styles.resultsLayout}>
            <PrimaryResultCard
              result={primaryResult}
              researchWorkflow={primaryResult.kind === "workflow"
                ? stringValue(readPath(data.workflows, "selectedDetail.run.id")) === primaryResult.key?.slice("workflow:".length)
                  ? readPath(data.workflows, "selectedDetail")
                  : { run: workflowRuns.find((run) => `workflow:${run.id}` === primaryResult.key) }
                : undefined}
              researchRun={primaryResult.kind === "agent" ? agentRuns.find((run) => `agent:${run.id}` === primaryResult.key) : undefined}
              canceling={Boolean(cancelingRunId)}
              onCancel={() => void cancelAgentResult(primaryResult)}
            />

            <section className={styles.ledger} aria-labelledby="recent-results-title">
              <div className={styles.sectionHeading}>
                <h2 id="recent-results-title">Recent results</h2>
                <p>Select a run to read its full output.</p>
              </div>
              <ResultPanel title="Workflow outcomes" description="Durable runs and their current step.">
                <ResultRows
                  rows={workflowRuns.map((run) => ({
                    key: `workflow:${stringValue(run.id)}`,
                    title: stringValue(run.goal, "Workflow"),
                    status: stringValue(run.status, "unknown"),
                    meta: workflowMeta(run),
                    body: resultPreview(run.report || run.error),
                  }))}
                  empty={resourceError(data.workflows) ? "Workflow results are unavailable. Retry the source above." : "No workflow results found."}
                  icon={Workflow}
                  onSelect={selectResult}
                  selectedKey={primaryResult.key}
                />
              </ResultPanel>
              <ResultPanel title="Agent answers" description="Direct runs and their returned responses.">
                <ResultRows
                  rows={agentRuns.map((run) => ({
                    key: `agent:${stringValue(run.id)}`,
                    title: stringValue(run.prompt, "Agent run"),
                    status: stringValue(run.status, "unknown"),
                    meta: agentResultMeta(run),
                    body: resultPreview(run.response || run.error),
                  }))}
                  empty={resourceError(data.runs) ? "Agent answers are unavailable. Retry the source above." : "No agent answers found."}
                  icon={TerminalSquare}
                  onSelect={selectResult}
                  selectedKey={primaryResult.key}
                />
              </ResultPanel>
            </section>
          </div>

          {approvalItems.length > 0 ? <section className={styles.approvals} aria-labelledby="result-blockers-title">
            <div className={styles.sectionHeading}>
              <h2 id="result-blockers-title">Waiting for your decision</h2>
              <p>Resolve these requests before the outcome is final.</p>
            </div>
            <ResultRows
              rows={approvalItems.map((item) => ({
                title: stringValue(item.title, "Approval"),
                status: stringValue(item.status, "waiting"),
                meta: `${stringValue(item.kind, "approval")} / risk ${stringValue(item.riskLevel, "n/a")}`,
                body: resultPreview(item.reason || readPath(item, "record.error")),
                href: "/app/approvals",
              }))}
              empty={resourceError(data.approvals) ? "Approval state is unavailable. The source notice above has more detail." : "No approval blockers are waiting."}
              icon={ShieldCheck}
            />
          </section> : null}

          <div className={styles.sharedOutputs}>
            <GeneratedArtifactsShelf refreshKey={lastRefresh} />
          </div>

          <WorkspaceLibrary
            title="Reusable outputs"
            description="Images and transcripts remain attached to their source, stable citation, and relevant work."
            kinds={RESULT_LIBRARY_KINDS}
            compact
            limit={12}
            className={styles.library}
          />

          <details className={styles.disclosure}>
            <summary>Sources, verification, and runtime evidence</summary>
            <div className={styles.disclosureBody}>
              <p className={styles.contextDescription}>Source counts describe loaded records. A completed run still needs its verification and evidence reviewed.</p>
              <dl className={styles.metrics}>
                <Metric
                  label="Completed agent runs"
                  value={resourceMetric(state, signedIn, data.runs, agentRuns.filter((run) => stringValue(run.status) === "completed").length.toString())}
                />
                <Metric label="Workflows" value={resourceMetric(state, signedIn, data.workflows, workflowRuns.length.toString())} />
                <Metric label="Waiting approval" value={resourceMetric(state, signedIn, data.approvals, approvalItems.length.toString())} />
                <Metric label="Evaluations" value={resourceMetric(state, signedIn, data.evaluations, evaluationRuns.length.toString())} />
              </dl>
              <div className={styles.evidenceLinks}>
                <EvidenceLink label="Release" value="Open release gate" href="/app/settings?section=quality" />
                <EvidenceLink
                  label="Evaluations"
                  value={resourceMetric(state, signedIn, data.evaluations, `${evaluationRuns.length} runs`)}
                  href="/app/settings?section=quality"
                />
                <EvidenceLink label="Runtime" value="Open monitoring" href="/app/settings?section=monitoring" />
              </div>
              <ResultPanel title="Recent evaluations" description="Recorded checks and their exact run status.">
                <ResultRows
                  rows={evaluationRuns.slice(0, 4).map((run) => ({
                    title: stringValue(run.suite, "Evaluation suite"),
                    status: stringValue(run.status, "unknown"),
                    meta: formatResultTime(stringValue(run.completedAt || run.startedAt || run.createdAt)),
                    body: `Passed ${stringPath(run, "summary.passed", "0")} of ${stringPath(run, "summary.total", "0")} checks.`,
                    href: "/app/settings?section=quality",
                  }))}
                  empty={resourceError(data.evaluations) ? "Evaluation evidence is unavailable. Retry the source above." : "No evaluation runs loaded."}
                  icon={CheckCircle2}
                />
              </ResultPanel>
            </div>
          </details>

          <details className={styles.disclosure}>
            <summary>Result status guide</summary>
            <ul className={styles.statusGuide}>
              <NextStepRow
                icon={CheckCircle2}
                title="Completed"
                body="Read the output, then review its verification and evidence before relying on it."
                active={primaryResult.status === "completed"}
              />
              <NextStepRow
                icon={RefreshCw}
                title="Active"
                body="Open the Timeline tab to follow progress. A running or queued item is not a completed result."
                active={["running", "queued", "pending", "waiting_clarification"].includes(primaryResult.status)}
              />
              <NextStepRow
                icon={AlertTriangle}
                title="Waiting approval"
                body="Open Approvals, decide the request, then return after the workflow advances."
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
                body="Start or continue a task in Assistant. Results will appear here after execution."
                active={primaryResult.kind === "empty"}
              />
            </ul>
          </details>
        </>
      ) : null}
    </div>
  );
}

function PrimaryResultCard({
  result,
  researchWorkflow,
  researchRun,
  canceling,
  onCancel,
}: {
  result: PrimaryResult;
  researchWorkflow?: unknown;
  researchRun?: JsonRecord;
  canceling: boolean;
  onCancel: () => void;
}) {
  const title = resultTitle(result.title);
  const request = result.title;
  const canCancel =
    result.kind === "agent" &&
    ["running", "waiting_approval", "resuming"].includes(
      result.status.toLowerCase(),
    );
  return (
    <section className={styles.currentResult} aria-labelledby="current-result-title">
      <div className={styles.resultHeading}>
        <p className={styles.resultLabel}>Current result</p>
        <StatusPill label={result.status} tone={result.tone} />
        <h2 id="current-result-title">{title}</h2>
        <p className={styles.resultMeta}>{result.meta}</p>
      </div>
      {request !== title ? <details className={styles.requestDisclosure}>
        <summary>Read full request</summary><p tabIndex={0}>{request}</p>
      </details> : null}
      {researchViewFromWorkflow(researchWorkflow) || researchRun?.mode === "research"
        ? <ResearchPanel workflow={researchWorkflow} directRun={researchRun} renderReport={(content, grounding) => <ResultReport content={content} grounding={grounding} />} />
        : <div className={styles.resultBody}><ResultReport content={result.body} /></div>}
      <div className={styles.actions}>
        <Link href={result.href} className={styles.button}>
          {result.href.startsWith("/app/results?")
            ? "Permanent link to this result"
            : "Open source workspace"}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
        {canCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={canceling}
            className={clsx(styles.button, styles.cancelButton)}
          >
            {canceling ? <Loader2 size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}
            {canceling ? "Canceling run" : "Cancel run"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function NextStepRow({ icon: Icon, title, body, active }: { icon: typeof FileText; title: string; body: string; active: boolean }) {
  return (
    <li className={styles.guideRow}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <p className={styles.guideTitle}>{title}{active ? <span className={styles.currentState}>Current state</span> : null}</p>
        <p>{body}</p>
      </div>
    </li>
  );
}

function ResultPanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className={styles.resultPanel}>
      <div className={styles.panelHeading}>
        <h3>{title}</h3>
        <p>{description}</p>
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
  selectedKey,
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
  selectedKey?: string;
}) {
  if (!rows.length) {
    return <p className={styles.empty}>{empty}</p>;
  }

  return (
    <ul className={styles.resultList}>
      {rows.slice(0, 8).map((row, index) => {
        const selected = Boolean(row.key && row.key === selectedKey);
        const content = (
          <>
            <Icon size={18} className={styles.rowIcon} aria-hidden="true" />
            <span className={styles.rowCopy}>
              <span className={styles.rowTitle}>{resultTitle(row.title)}</span>
              <span className={styles.rowStatus}>
                <StatusPill label={row.status} tone={toneForStatus(row.status)} />
                {selected ? <span className={styles.selectedLabel}>Selected</span> : null}
              </span>
              <span className={styles.rowMeta}>{friendlyResultText(row.meta)}</span>
              <span className={styles.rowPreview}>{friendlyResultText(row.body)}</span>
            </span>
          </>
        );
        return (
          <li key={row.key || `${row.title}-${index}`}>
            {row.key && onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(row.key!)}
                className={clsx(styles.resultRow, selected && styles.selectedRow)}
                aria-pressed={selected}
              >
                {content}
              </button>
            ) : row.href ? (
              <Link href={row.href} className={styles.resultRow}>
                {content}
              </Link>
            ) : (
              <div className={styles.resultRow}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EvidenceLink({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className={styles.evidenceLink}>
      <span>{label}</span>
      <span>{value}<ArrowRight size={16} aria-hidden="true" /></span>
    </Link>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={clsx(styles.status, styles[tone])}>{label.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function unavailableSelectedResult(): PrimaryResult {
  return {
    kind: "unknown",
    title: "Linked result is unavailable",
    status: "unavailable",
    body:
      "This result could not be loaded. It may have expired under the retention policy, belong to another workspace, or use an invalid link.",
    meta: "Try another result or refresh your workspace.",
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
    body: "Start a task. Its latest run, workflow, or approval state will appear here after execution begins.",
    meta: "Your completed work and saved outputs will collect here.",
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

async function loadSelectedResult(
  requestedResultKey: string | undefined,
  runsPayload: JsonRecord,
  workflowsPayload: JsonRecord,
  signal: AbortSignal,
) {
  if (requestedResultKey?.startsWith("agent:")) {
    const runId = requestedResultKey.slice("agent:".length);
    if (runId) {
      const direct = asRecord(
        await readJson(`/api/runs/${encodeURIComponent(runId)}`, {
          signal,
        }).catch(() => ({})),
      );
      const directRun = asRecord(direct.run);
      if (stringValue(directRun.id) === runId) {
        directRun.agentIdentity = direct.agentIdentity;
        runsPayload.runs = [
          directRun,
          ...arrayPath(runsPayload, "runs").filter(
            (run) => stringValue(run.id) !== runId,
          ),
        ];
      }
    }
  }
  if (requestedResultKey?.startsWith("workflow:")) {
    const runId = requestedResultKey.slice("workflow:".length);
    if (runId) {
      const direct = asRecord(
        await readJson(`/api/workflows/${encodeURIComponent(runId)}`, {
          signal,
        }).catch(() => ({})),
      );
      const directRun = asRecord(direct.run);
      if (stringValue(directRun.id) === runId) {
        workflowsPayload.selectedDetail = direct;
        workflowsPayload.runs = [
          directRun,
          ...arrayPath(workflowsPayload, "runs").filter((run) => stringValue(run.id) !== runId),
        ];
      }
    }
  }
}

function workspaceSourcePayload(
  summary: JsonRecord,
  sourceKey: "runs" | "workflows" | "approvals",
  dataKey: "runs" | "items",
) {
  const source = asRecord(readPath(summary, `sources.${sourceKey}`));
  if (source.status === "ready") {
    return {
      [dataKey]: Array.isArray(source.data) ? source.data : [],
    };
  }
  return {
    error: stringValue(source.error, "Resource unavailable."),
    [dataKey]: [],
  };
}

function retainStalePayload(
  current: JsonRecord | undefined,
  next: JsonRecord,
  dataKey: "runs" | "items",
) {
  if (
    next.error &&
    current &&
    Array.isArray(current[dataKey]) &&
    current[dataKey].length
  ) {
    return {
      ...current,
      error: next.error,
      stale: true,
    };
  }
  return next;
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

function workflowMeta(run: JsonRecord) {
  const outcome = stringPath(run, "canonicalStatus.status", "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ");
  return [
    outcome ? `Outcome: ${outcome}` : "",
    formatResultTime(stringValue(run.completedAt || run.updatedAt || run.createdAt)),
  ].filter(Boolean).join(" / ");
}

function agentResultMeta(run: JsonRecord) {
  const card = asRecord(readPath(run, "agentIdentity.card"));
  const identity = stringValue(card.name)
    ? `${stringValue(card.name)} (${stringValue(card.role, "Agent")})`
    : "Assistant";
  return [
    identity,
    formatResultTime(stringValue(run.completedAt || run.startedAt)),
  ].join(" / ");
}

function withWorkflowOutcomeMetadata(
  timeline: ResultTimelineItem[],
  workflowRuns: JsonRecord[],
) {
  const workflowsByKey = new Map<string, JsonRecord>();
  for (const run of workflowRuns) {
    const runId = stringValue(run.id);
    if (runId) {
      workflowsByKey.set(`workflow:${runId}`, run);
    }
  }
  return timeline.map((item) => {
    if (item.kind !== "workflow") {
      return item;
    }
    const run = workflowsByKey.get(item.key);
    return run ? { ...item, meta: workflowMeta(run) } : item;
  });
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

function resourceError(value: unknown) {
  const record = asRecord(value);
  return stringValue(record.error || record.message);
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

// Presentation only: preserve original requests and reports for deliberate review.
function friendlyResultText(value: string) {
  return value
    .replace(/(?:captureasset:)?capture_asset_[A-Za-z0-9_-]+/g, "saved capture")
    .replace(/\b(?:project|appbuild|agent|run)_[a-f0-9]{16,}\b/gi, "workspace reference");
}

function resultTitle(value: string) {
  const text = friendlyResultText(value).trim().replace(/^#{1,6}\s*/, "")
    .split(/\r?\n/).find((line) => line.trim())?.trim() || "Untitled task";
  const sentence = text.match(/^.{12,140}?[.!?](?:\s|$)/)?.[0]?.trim() || text;
  if (sentence.length <= 120) return sentence;
  const prefix = sentence.slice(0, 117);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > 75 ? boundary : prefix.length)}…`;
}
