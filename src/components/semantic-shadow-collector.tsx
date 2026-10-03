"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";
import {
  collectSemanticShadowBatch,
  createSemanticCollectionGate,
  createSemanticPollGate,
  isRecord,
  isTerminalSemanticJob,
  mergeSemanticShadowJobs,
  parseSemanticEnqueueReceipt,
  parseSemanticPoll,
  parseSemanticThreadIds,
  semanticShadowBatchSize,
  semanticShadowReadState,
  validSemanticShadowStats,
  type SemanticEnqueueReceipt,
  type SemanticShadowJob,
  type SemanticShadowStats,
} from "@/components/semantic-shadow-collector-state";
import styles from "@/components/semantic-shadow-collector.module.css";

export { mergeSemanticShadowJobs, parseSemanticShadowJob, semanticShadowBatchSize } from "@/components/semantic-shadow-collector-state";
export type { SemanticShadowJob } from "@/components/semantic-shadow-collector-state";

type CollectorProps = {
  semanticShadow?: SemanticShadowStats;
  overviewLoading: boolean;
  overviewError?: string;
  onProgressChanged: () => Promise<void>;
};
type JobRead = { confirmed: boolean; detail: string };

export function SemanticShadowCollector(props: CollectorProps) {
  const { session, status } = useWorkspaceSession();
  const disabledReason = permissionMessage(session, status, "write.memory");
  const scope = JSON.stringify([session?.context?.tenantId, session?.context?.actorId]);
  return <Collector key={scope} {...props} disabledReason={disabledReason} />;
}

function Collector({ semanticShadow, overviewLoading, overviewError, onProgressChanged, disabledReason }: CollectorProps & { disabledReason?: string }) {
  const [gate] = useState(createSemanticCollectionGate);
  const [pollGate] = useState(createSemanticPollGate);
  const [collecting, setCollecting] = useState(false);
  const [jobs, setJobs] = useState<SemanticShadowJob[]>([]);
  const [receipts, setReceipts] = useState<SemanticEnqueueReceipt[]>([]);
  const [feedback, setFeedback] = useState("");
  const [jobReads, setJobReads] = useState<Record<string, JobRead>>({});
  const [polling, setPolling] = useState(false);
  const [unexpectedPollRows, setUnexpectedPollRows] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const [refreshError, setRefreshError] = useState("");
  const permissionRef = useRef(disabledReason);
  const completionSignature = useRef("");
  const refreshRevision = useRef(0);

  useLayoutEffect(() => { permissionRef.current = disabledReason; }, [disabledReason]);
  useLayoutEffect(() => {
    gate.mount();
    return () => { gate.dispose(); pollGate.invalidate(); refreshRevision.current += 1; };
  }, [gate, pollGate]);

  const activeSignature = useMemo(() => jobs.filter((job) => !isTerminalSemanticJob(job)).map((job) => job.id).sort().join("|"), [jobs]);
  const activeCount = jobs.filter((job) => !isTerminalSemanticJob(job)).length;
  const completedCount = jobs.filter((job) => job.status === "completed").length;
  const attentionCount = jobs.filter((job) => job.status === "failed" || job.status === "canceled").length;
  const unconfirmedCount = jobs.filter((job) => jobReads[job.id]?.confirmed === false).length;
  const pollError = unconfirmedCount ? `${unconfirmedCount} ${unconfirmedCount === 1 ? "job status remains" : "job statuses remain"} unconfirmed. Last confirmed statuses are retained.`
    : unexpectedPollRows ? "The status response included unrecognized records. Only requested, verified jobs were updated." : "";
  const readState = semanticShadowReadState(semanticShadow, overviewLoading, overviewError || refreshError);
  const stats = validSemanticShadowStats(semanticShadow) ? semanticShadow : undefined;
  const batchSize = semanticShadowBatchSize(stats);
  const blocked = disabledReason || (collecting ? "A collection request is in progress." : undefined) ||
    (readState !== "ready" ? "Refresh the collection counts before starting another batch." : undefined) ||
    (!batchSize ? "The episode and conversation collection targets are met. Human review is still required." : undefined);

  const refreshOverview = useCallback(async () => {
    const revision = ++refreshRevision.current;
    setRefreshError("");
    try { await onProgressChanged(); }
    catch {
      if (gate.isMounted() && revision === refreshRevision.current) setRefreshError("Collection counts could not be refreshed. Confirmed job receipts are retained.");
    }
  }, [gate, onProgressChanged]);

  useEffect(() => {
    if (!activeSignature || collecting) return;
    const ids = activeSignature.split("|");
    const isLatestPoll = pollGate.begin();
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isLatestPoll() && gate.isMounted();
    const stop = startVisibleRefresh({
      refreshOnStart: true,
      pollIntervalMs: 2_500,
      onRefresh: async () => {
        if (!isCurrent()) return;
        setPolling(true);
        const updates: SemanticShadowJob[] = [];
        const reads: Record<string, JobRead> = {};
        let unexpected = false;
        // The batch endpoint accepts at most 100 IDs; local history has no server cursor.
        for (let index = 0; index < ids.length; index += 100) {
          if (!isCurrent()) return;
          const requested = ids.slice(index, index + 100);
          try {
            const response = await fetch(`/api/operations/jobs?ids=${requested.map(encodeURIComponent).join(",")}`, { cache: "no-store", signal: controller.signal });
            const body: unknown = await response.json();
            if (!response.ok) throw new Error("Status read failed");
            const result = parseSemanticPoll(body, requested);
            updates.push(...result.jobs);
            unexpected ||= result.unexpected;
            result.jobs.forEach((job) => { reads[job.id] = { confirmed: true, detail: "Status confirmed by the latest read." }; });
            result.unconfirmedIds.forEach((id) => { reads[id] = { confirmed: false, detail: "The latest read did not confirm this job. Showing its last confirmed status." }; });
          } catch {
            requested.forEach((id) => { reads[id] = { confirmed: false, detail: "Status could not be refreshed. Showing its last confirmed status." }; });
          }
        }
        if (!isCurrent()) return;
        setJobs((current) => mergeSemanticShadowJobs(current, updates));
        setJobReads((current) => ({ ...current, ...reads }));
        setUnexpectedPollRows(unexpected);
        setPolling(false);
      },
    });
    return () => { controller.abort(); stop(); };
  }, [activeSignature, collecting, gate, pollGate, pollRevision]);

  const terminalSignature = !activeCount && jobs.length ? jobs.map((job) => `${job.id}:${job.status}:${job.progress?.outcome ?? ""}`).sort().join("|") : "";
  useEffect(() => {
    if (collecting || !terminalSignature || terminalSignature === completionSignature.current) return;
    const timer = window.setTimeout(() => {
      if (!gate.isMounted()) return;
      completionSignature.current = terminalSignature;
      void refreshOverview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [collecting, gate, refreshOverview, terminalSignature]);

  async function collectNextBatch() {
    if (blocked) return;
    const token = gate.begin();
    if (token === undefined) return;
    pollGate.invalidate();
    setCollecting(true);
    setUnexpectedPollRows(false);
    setReceipts([]);
    setFeedback("Checking up to 48 recent conversations for complete 12-turn episodes.");
    try {
      const response = await fetch("/api/threads?limit=100", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!gate.isCurrent(token)) return;
      if (!response.ok) throw new Error(errorMessage(body, "Recent conversations could not be loaded. No collection requests were started."));
      const threadIds = parseSemanticThreadIds(body);
      if (!threadIds) throw new Error("The conversation list could not be verified. No collection requests were started.");
      if (!threadIds.length) {
        setFeedback("No recent conversations were returned by this bounded read. No collection requests were started.");
        return;
      }
      const result = await collectSemanticShadowBatch({
        threadIds,
        batchSize,
        isCurrent: () => gate.isCurrent(token),
        canContinue: () => !permissionRef.current,
        enqueue: enqueueThread,
        onBatch: (batch) => {
          const confirmed = batch.flatMap((receipt) => receipt.jobs);
          setReceipts((current) => [...current, ...batch]);
          if (confirmed.length) {
            completionSignature.current = "";
            setJobs((current) => mergeSemanticShadowJobs(current, confirmed, "enqueue"));
            setJobReads((current) => ({ ...current, ...Object.fromEntries(confirmed.map((job) => [job.id, { confirmed: true, detail: "Job receipt confirmed by the collection response." }])) }));
          }
        },
      });
      if (!gate.isCurrent(token)) return;
      const uncertain = result.receipts.filter((receipt) => receipt.issue).length;
      const unconfigured = result.receipts.some((receipt) => receipt.status === "not_configured");
      const waiting = result.receipts.length > 0 && result.receipts.every((receipt) => !receipt.issue && receipt.status === "waiting_for_sealed_episode");
      const conversationLabel = result.inspected === 1 ? "conversation" : "conversations";
      const receiptLabel = `${result.jobCount} job ${result.jobCount === 1 ? "receipt" : "receipts"}`;
      setFeedback(uncertain
        ? `Checked ${result.inspected} ${conversationLabel}. ${receiptLabel} confirmed; ${uncertain} request ${uncertain === 1 ? "outcome is" : "outcomes are"} unconfirmed or failed. Later requests were stopped.`
        : unconfigured ? `Checked ${result.inspected} ${conversationLabel}. Choose a Memory model in Settings before collecting more episodes. ${receiptLabel} retained.`
        : permissionRef.current ? `Collection stopped because workspace permissions are unavailable. ${receiptLabel} retained.`
        : waiting ? `Checked ${result.inspected} recent ${conversationLabel}. None returned a complete new 12-turn episode.`
        : `Checked ${result.inspected} ${conversationLabel}. ${receiptLabel} confirmed. Inspect the returned status and outcome below.`);
      // This callback requests a GET refresh; only the overview props establish freshness.
      void refreshOverview();
    } catch (error) {
      if (gate.isCurrent(token)) setFeedback(error instanceof Error ? error.message : "Collection could not be confirmed. Existing job receipts are retained.");
    } finally {
      if (gate.isCurrent(token)) { gate.finish(token); setCollecting(false); }
    }
  }

  const sourceMessage = readState === "loading" ? "Loading collection counts…"
    : readState === "unavailable" ? "Collection counts are unavailable. Target completion has not been confirmed."
    : overviewLoading ? "Refreshing collection counts. Showing last-loaded counts."
    : readState === "stale" ? "Collection counts could not be refreshed. Showing last-loaded counts."
    : batchSize ? "Collection counts are current for the last successful overview read."
    : "Collection targets are met. Human review is still required.";
  const terminalAnnouncement = terminalSignature ? `${completedCount} completed ${completedCount === 1 ? "job" : "jobs"}; ${attentionCount} failed or canceled. Completion does not mean every job produced a new enrichment.` : "";

  return <section className={styles.collector} aria-labelledby="semantic-shadow-lab-title">
    <header className={styles.heading}>
      <div><p>Evaluation lane</p><h3 id="semantic-shadow-lab-title">Semantic shadow lab</h3><span>Collect bounded episode enrichments for human review. They cannot change live recall, answers or accepted memory.</span></div>
      <button type="button" onClick={() => void refreshOverview()} disabled={overviewLoading}><RefreshCw size={16} aria-hidden="true" />Refresh collection counts</button>
    </header>
    <p className={styles.resourceState} role="status" aria-live="polite" data-state={readState}>{sourceMessage}</p>
    {overviewError || refreshError ? <p className={styles.readError}><TriangleAlert size={16} aria-hidden="true" /><span>{overviewError || refreshError}</span></p> : null}
    <dl className={styles.counts} aria-label="Collection counts">
      <div><dt>Collected episodes</dt><dd>{stats ? `${stats.currentEpisodeCount} / ${stats.minimumEpisodeTarget}` : "Unavailable"}</dd></div>
      <div><dt>Distinct conversations</dt><dd>{stats ? `${stats.distinctThreadCount} / ${stats.minimumThreadTarget}` : "Unavailable"}</dd></div>
    </dl>
    {stats ? <div className={styles.progress}><progress value={Math.min(100, stats.currentEpisodeCount / stats.minimumEpisodeTarget * 100)} max={100} aria-label="Semantic shadow episode collection progress" /><span>Episode target only; the conversation target must also be met.{readState === "stale" ? " Based on last-loaded counts." : ""}</span></div> : null}
    <div className={styles.collectionAction}>
      <div><strong>Collect the next bounded batch</strong><p>Uses the Memory model selected in Settings. Each conversation contributes at most one requested episode in this batch.</p><p id="semantic-collection-help">{blocked || `Requests up to ${batchSize} jobs from at most 48 recent conversations, four requests at a time.`}</p>{collecting ? <p>Leaving Reviews stops later local requests. Work already sent to the server is not canceled.</p> : null}</div>
      <button className={styles.primaryButton} type="button" onClick={() => void collectNextBatch()} disabled={Boolean(blocked)} aria-describedby="semantic-collection-help"><Play size={16} aria-hidden="true" />{collecting ? "Checking conversations…" : batchSize ? `Collect up to ${batchSize}` : "Collect episodes"}</button>
    </div>
    <p className={styles.feedback} role="status" aria-live="polite">{feedback}</p>
    {receipts.length ? <details className={styles.receipts}><summary>Latest collection responses ({receipts.length})</summary><ol>{receipts.map((receipt) => <li key={receipt.threadId}><span>Conversation ID</span><code>{receipt.threadId}</code><p>{receipt.issue || receiptLabel(receipt.status)}</p>{receipt.issue && receipt.status ? <p>Returned disposition: {receiptLabel(receipt.status)}</p> : null}</li>)}</ol></details> : null}
    <section className={styles.jobSection} aria-labelledby="semantic-collection-jobs-title">
      <header><div><h4 id="semantic-collection-jobs-title">Collection jobs</h4><p>{jobs.length ? `${activeCount} active · ${completedCount} completed · ${attentionCount} failed or canceled` : "Job receipts appear here after an explicit collection in this view."}</p></div><button type="button" disabled={!activeCount || collecting} aria-describedby="semantic-job-read-help" onClick={() => { pollGate.invalidate(); setPollRevision((revision) => revision + 1); }}><RefreshCw size={16} aria-hidden="true" />Refresh job statuses</button></header>
      <p className={styles.resourceState} id="semantic-job-read-help">{collecting ? "Status reads resume after the collection requests finish." : activeCount ? polling ? "Checking active job statuses. Last confirmed statuses remain visible." : "Active jobs refresh while this page is visible." : jobs.length ? "All listed jobs have a confirmed terminal status." : "No collection job receipts have been returned in this view."}</p>
      <p className={styles.pollNotice} role="status" aria-live="polite">{pollError}</p>
      <p className={styles.srOnly} role="status" aria-live="polite">{terminalAnnouncement}</p>
      <ol className={styles.jobs} aria-label="Collection jobs">{jobs.map((job, index) => <li key={job.id} data-job-id={job.id}>
        <header><h5>Job {index + 1}</h5><span data-status={job.status}>{startCase(job.status)}</span></header>
        <dl><div><dt>Job ID</dt><dd><code>{job.id}</code></dd></div><div><dt>Conversation ID</dt><dd>{job.threadId ? <code>{job.threadId}</code> : "Not reported"}</dd></div><div><dt>State</dt><dd>{startCase(job.status)}</dd></div><div><dt>Stage</dt><dd>{job.progress?.stage ? startCase(job.progress.stage) : "Not reported"}</dd></div><div><dt>Outcome</dt><dd>{job.progress?.outcome ? outcomeLabel(job.progress.outcome) : "Not reported"}</dd></div>{job.failureCode ? <div><dt>Failure code</dt><dd><code>{job.failureCode}</code></dd></div> : null}</dl>
        <p className={styles.jobRead} data-confirmed={jobReads[job.id]?.confirmed !== false}>{jobReads[job.id]?.detail || "Last confirmed collection receipt."}</p>
      </li>)}</ol>
    </section>
    <p className={styles.boundary}><FlaskConical size={16} aria-hidden="true" /><span>Collection is evaluation-only. Human-reviewed evidence across all ten scenario dimensions is still required. Passing the gate never activates semantic memory automatically.</span></p>
  </section>;
}

async function enqueueThread(threadId: string): Promise<SemanticEnqueueReceipt> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "enqueue_semantic_summaries", limit: 1 }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  return response.ok ? parseSemanticEnqueueReceipt(body, threadId) : {
    threadId,
    jobs: [],
    issue: errorMessage(body, "The collection request failed. No job receipt was confirmed for this conversation."),
  };
}

function errorMessage(value: unknown, fallback: string) {
  return isRecord(value) && typeof value.message === "string" ? value.message : isRecord(value) && typeof value.error === "string" ? value.error : fallback;
}
function startCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (match) => match.toUpperCase()); }
function outcomeLabel(value: string) {
  return value === "enriched" ? "Enriched (evaluation-only)" : value === "already_current" ? "Already current; no new enrichment" : value === "superseded" ? "Superseded; no enrichment applied" : "Not reported";
}
function receiptLabel(value?: string) {
  return value === "not_configured" ? "Memory model is not configured."
    : value === "waiting_for_sealed_episode" ? "Waiting for a complete 12-turn episode."
    : value === "source_changed" ? "Episode source changed before collection."
    : value === "up_to_date" ? "No additional job was queued; inspect any returned job receipt."
    : value === "queued" ? "Job receipts returned; their current status is listed below."
    : "Collection disposition was not confirmed.";
}
