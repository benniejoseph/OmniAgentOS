"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ResearchProgress } from "@/lib/research/contracts";
import type { GroundingReport as StoredGroundingReport } from "@/lib/rag/citations";
import styles from "./research.module.css";

type RecordValue = Record<string, unknown>;
// Source links are a display projection. Do not pass private claim evidence
// or upgrade citation presence into a verified-claim receipt.
type GroundingReport = Pick<StoredGroundingReport, "status" | "citedIds" | "invalidIds" | "sources">;
type Source = { citationId: string; title: string; url: string; evidenceKind: string };
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, max = 4_000) => typeof value === "string" ? value.slice(0, max) : "";
const texts = (value: unknown, max = 40) => Array.isArray(value) ? value.slice(0, max).map((item) => text(item)).filter(Boolean) : [];
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const stages = { planning: "Planning the research", searching: "Finding sources", reading: "Reading source material", reviewing: "Reviewing claims and gaps", writing: "Writing the report", complete: "Research finished" } as const;

export function readResearchProgress(value: unknown): ResearchProgress | undefined {
  const source = record(value);
  if (source.schemaVersion !== 1 || !["quick", "deep"].includes(String(source.depth)) || !Object.hasOwn(stages, String(source.stage))) return undefined;
  return { schemaVersion: 1, depth: source.depth as ResearchProgress["depth"], stage: source.stage as ResearchProgress["stage"],
    questions: texts(source.questions, 6), searches: count(source.searches), sourcesRead: count(source.sourcesRead),
    gaps: texts(source.gaps), limitations: texts(source.limitations),
    ...(["ready", "partial"].includes(String(source.reportStatus)) ? { reportStatus: source.reportStatus as "ready" | "partial" } : {}) };
}

function safeSources(value: unknown): Source[] {
  return (Array.isArray(value) ? value.slice(0, 100) : []).flatMap((entry) => {
    const source = record(entry);
    try {
      const url = new URL(text(source.url));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return [];
      return [{ citationId: text(source.citationId, 200), title: text(source.title, 1_000) || url.hostname,
        url: url.href, evidenceKind: source.evidenceKind === "read_extract" ? "read_extract" : source.evidenceKind === "search_discovery" ? "search_discovery" : "cited" }];
    } catch { return []; }
  });
}

export function researchViewFromWorkflow(detail: unknown) {
  const root = record(detail); const run = record(root.run); const result = record(run.result);
  const report = record(result.researchReportV1);
  const options = record(record(record(run.input).metadata).researchOptionsV1);
  const outputs = (Array.isArray(root.steps) ? root.steps : []).map((step) => record(record(step).output)).reverse();
  const progress = readResearchProgress(result.researchProgress) || outputs.map((output) => readResearchProgress(output.researchProgress)).find(Boolean);
  if (!progress && report.schemaVersion !== 1 && options.depth !== "deep") return undefined;
  const plan = report.schemaVersion === 1 ? record(report.plan) : options;
  const content = text(report.content, 250_000);
  const draft = outputs.map((output) => text(output.response, 250_000)).find(Boolean) || "";
  const sources = safeSources(report.sources);
  return { progress, workflowId: text(run.id, 200), title: text(report.title, 1_000) || "Deep research", status: text(run.status, 40),
    startedAt: text(run.createdAt, 100), endedAt: text(run.completedAt || run.updatedAt, 100),
    reportStatus: report.status === "partial" ? "partial" : report.status === "ready" ? "ready" : undefined,
    content, draft, sources, questions: progress?.questions || [], sourceGuidance: text(plan.sourceGuidance, 1_500),
    domains: texts(plan.allowedDomains, 10), limitations: [...new Set([...texts(report.limitations), ...(progress?.limitations || [])])],
    claimReview: record(report.claimReview) };
}

export function researchGroundingForWorkflow(workflow: unknown): GroundingReport | undefined {
  const view = researchViewFromWorkflow(workflow);
  if (!view?.sources.length) return undefined;
  return { status: "not_required", citedIds: view.sources.map((source) => source.citationId), invalidIds: [],
    sources: view.sources.map((source) => ({ citationId: source.citationId, evidenceId: source.url, title: source.title, url: source.url, kind: "web" })) };
}

export function ResearchPanel({ workflow, progress: liveProgress, disabledReason, pending, error, onSignal, onRefresh, renderReport, showReport = true, directReport, directStatus, directRun }: {
  workflow?: unknown;
  progress?: ResearchProgress;
  disabledReason?: string;
  pending?: boolean;
  error?: string;
  onSignal?: (signal: "pause" | "resume" | "cancel") => void;
  onRefresh?: () => void;
  renderReport?: (content: string, grounding: GroundingReport) => ReactNode;
  showReport?: boolean;
  directReport?: string;
  directStatus?: "complete" | "failed" | "canceled";
  directRun?: unknown;
}) {
  const view = researchViewFromWorkflow(workflow);
  const savedRun = record(directRun);
  const savedQuick = savedRun.mode === "research";
  const progress = view?.progress || liveProgress;
  const active = Boolean(view && !["completed", "failed", "canceled"].includes(view.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, [active]);
  if (!progress && !view && !savedQuick) return null;
  const status = view?.status || directStatus || (savedQuick ? text(savedRun.status, 40) : undefined);
  const stopped = status === "failed" || status === "canceled";
  const partial = view?.reportStatus === "partial" || progress?.reportStatus === "partial" || stopped;
  const content = view?.content || (stopped ? view?.draft : "") || (directStatus ? directReport : "") || (savedQuick ? text(savedRun.response, 250_000) : "") || "";
  const sources = view?.sources || (savedQuick ? safeSources(record(savedRun.grounding).sources) : []);
  const grounding: GroundingReport = { status: "not_required", citedIds: sources.map((source) => source.citationId), invalidIds: [],
    sources: sources.map((source) => ({ citationId: source.citationId, evidenceId: source.url, title: source.title, url: source.url, kind: "web" })) };
  const started = Date.parse(view?.startedAt || ""); const ended = active ? now : Date.parse(view?.endedAt || "");
  const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.floor((ended - started) / 60_000)) : undefined;
  const limitations = view?.limitations || progress?.limitations || [];
  const label = status === "paused" ? "Research paused" : status === "waiting_approval" ? "Waiting for approval" : status === "canceled" ? "Research stopped" : status === "failed" ? "Research interrupted" : progress ? stages[progress.stage] : active ? "Waiting to start research" : status === "completed" || status === "complete" ? "Research finished" : "Saved research report";
  function downloadReport() {
    const linkedContent = sources.reduce((markdown, source, index) => markdown.replaceAll(`[${source.citationId}]`, `[${index + 1}](<${source.url}>)`), content);
    const appendix = !view && sources.length ? `\n\n## Sources\n\n${sources.map((source, index) => `${index + 1}. [${source.title.replace(/[\[\]\\\n\r]/g, " ")}](<${source.url}>)`).join("\n")}` : "";
    const url = URL.createObjectURL(new Blob([linkedContent + appendix], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `${(view?.title || "research-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80) || "research-report"}.md`;
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <section className={styles.panel} aria-label="Research progress and report">
    <div className={styles.header}><div><h2>{view?.content ? view.title : `${view || progress?.depth === "deep" ? "Deep" : "Quick"} research`}</h2><p role="status">{label}{partial && content ? " · Partial report" : view?.reportStatus === "ready" ? " · Report ready" : ""}</p></div>
      <div className={styles.actions}>
        {onSignal && ["queued", "running", "paused"].includes(status || "") ? <button type="button" disabled={pending || Boolean(disabledReason)} title={disabledReason} onClick={() => onSignal(status === "paused" ? "resume" : "pause")}>{status === "paused" ? "Resume research" : "Pause research"}</button> : null}
        {onSignal && active ? <button type="button" disabled={pending || Boolean(disabledReason)} title={disabledReason} onClick={() => onSignal("cancel")}>Stop research</button> : null}
        {content ? <button type="button" onClick={downloadReport}>Export Markdown</button> : null}
        {error && onRefresh ? <button type="button" disabled={pending} onClick={onRefresh}>Refresh research</button> : null}
        {view?.workflowId ? <a href={`/app/results?run=${encodeURIComponent(`workflow:${view.workflowId}`)}`}>Open saved research</a> : null}
      </div>
    </div>
    {progress ? <p className={styles.counts}><span>{progress.searches} searches</span><span>{progress.sourcesRead} sources read</span>{elapsed !== undefined ? <span>{elapsed < 1 ? "Less than a minute elapsed" : `${elapsed} min elapsed`}</span> : null}</p> : null}
    {pending ? <p className={styles.notice} role="status">Updating research controls…</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {active ? <p className={styles.notice}>Progress is saved as work finishes. Pausing takes effect at the next safe checkpoint. You can open a new conversation while this research continues.</p> : null}
    {stopped && !content ? <p className={styles.notice}>No report draft was saved before this research stopped. The saved progress remains available.</p> : null}
    {stopped && content ? <p className={styles.notice}>This is the last saved draft. The full research and review may be incomplete.</p> : null}
    {progress?.questions.length ? <details open={!view?.content}><summary>Research plan · {progress.questions.length} questions</summary><ol className={styles.list}>{progress.questions.map((question, index) => <li key={index}>{question}</li>)}</ol>{view?.sourceGuidance ? <p className={styles.notice}>{view.sourceGuidance}</p> : null}{view?.domains.length ? <p className={styles.notice}>Sources restricted to {view.domains.join(", ")}</p> : null}</details> : null}
    {progress?.gaps.length ? <details open><summary>Open questions · {progress.gaps.length}</summary><ul className={styles.list}>{progress.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details> : null}
    {limitations.length ? <details open={partial}><summary>Limitations and review</summary><ul className={styles.list}>{limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>{view?.claimReview.totalClaimCount !== undefined ? <p className={styles.notice}>Exact source quotes matched {count(view.claimReview.checkedClaimCount)} of {count(view.claimReview.totalClaimCount)} reviewed claims. This checks selected source support; it does not establish factual truth.</p> : null}</details> : null}
    {sources.length ? <details><summary>Sources · {sources.length}</summary><ul className={styles.sources}>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><p>{new URL(source.url).hostname} · {source.evidenceKind === "read_extract" ? "Source extract read" : source.evidenceKind === "search_discovery" ? "Found in search; full source not read" : "Cited source"}</p></li>)}</ul></details> : null}
    {content && showReport ? <div className={styles.report}>{renderReport ? renderReport(content, grounding) : <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>}</div> : null}
  </section>;
}
