"use client";

import {
  Activity,
  CheckCircle2,
  FlaskConical,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useRef, useState } from "react";
import { AgentsLifecycleBoundary, useAgentRead, useAgentsLifecycle } from "./agents-workspace-lifecycle";
import { agentsActionRequest, adaptationsRead, adaptationReceipt, type AdaptationRead } from "@/components/agents-workspace-state";
import styles from "./agent-inspectors.module.css";

import { adaptationComparisonSuiteSchema, ADAPTATION_COMPARISON_MAX_AGE_MS, type AdaptationComparisonSuite } from "@/lib/agents/adaptation-comparison-schema";
import type { AgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";

type AdaptationAction =
  | Readonly<{ kind: "evaluate" | "compare" | "activate" | "rollback"; label: string }>
  | Readonly<{ kind: "blocked"; reason: string }>;

export function agentAdaptationAction(
  adaptation: AgentAdaptationV1,
  currentDefinitionVersion: number,
): AdaptationAction {
  if (adaptation.state === "active") {
    return { kind: "rollback", label: "Roll back" };
  }
  if (adaptation.state === "rolled_back") {
    return { kind: "blocked", reason: "Rolled back and retained as evidence." };
  }
  if (adaptation.observedDefinitionVersion !== currentDefinitionVersion) {
    return {
      kind: "blocked",
      reason: `Observed on release v${adaptation.observedDefinitionVersion}. Refresh evidence for v${currentDefinitionVersion}.`,
    };
  }
  if (adaptation.state === "observed") {
    return { kind: "evaluate", label: "Check eligibility" };
  }
  if (adaptation.evaluation?.verdict === "held") {
    return {
      kind: "blocked",
      reason: "Held because the evidence confidence threshold was not met. This is a policy check, not a behavior test.",
    };
  }
  if (adaptation.evaluation?.definitionVersion !== currentDefinitionVersion) {
    return {
      kind: "blocked",
      reason: `Evaluated on release v${adaptation.evaluation?.definitionVersion}. Refresh evidence for v${currentDefinitionVersion}.`,
    };
  }
  if (adaptation.comparison?.verdict !== "improved" || Date.now() - Date.parse(adaptation.comparison.completedAt) > ADAPTATION_COMPARISON_MAX_AGE_MS) return { kind: "compare", label: "Compare on example tasks" };
  return { kind: "activate", label: "Activate tested guidance" };
}

export function AgentAdaptationEditor(props: { agentId: string; agentName: string; compact?: boolean }) {
  return <AgentsLifecycleBoundary scope={props.agentId}><AdaptationEditor {...props} /></AgentsLifecycleBoundary>;
}
function AdaptationEditor({ agentId, agentName, compact = false }: { agentId: string; agentName: string; compact?: boolean }) {
  const { gate, busy, reason } = useAgentsLifecycle();
  const floor = useRef<AdaptationRead | undefined>(undefined);
  const read = useAgentRead(`/api/agents/${encodeURIComponent(agentId)}/adaptations`, (value) => {
    const next = adaptationsRead(value, agentId);
    const predatesConfirmed = floor.current?.adaptations.some((old) => !next.adaptations.some((item) =>
      item.adaptationId === old.adaptationId && item.lifecycleRevision >= old.lifecycleRevision &&
      (!old.comparison || item.lifecycleRevision > old.lifecycleRevision || Boolean(item.comparison &&
        Date.parse(item.comparison.pins.clock) >= Date.parse(old.comparison.pins.clock)))));
    if (predatesConfirmed) throw new Error("The read predates confirmed adaptation evidence. Last confirmed details are retained.");
    return next;
  });
  const adaptations = read.data?.adaptations || [], definitionVersion = read.data?.definitionVersion;
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const disabled = Boolean(busy || reason || !read.current);
  async function mutate(action: "refresh" | "evaluate" | "compare" | "activate" | "rollback", adaptationId?: string, suite?: AdaptationComparisonSuite) {
    if (!read.data || disabled) return;
    const body = { action, ...(adaptationId ? { adaptationId } : {}), ...(suite ? { suite } : {}) };
    const token = gate.begin(`/api/agents/${encodeURIComponent(agentId)}/adaptations`, "POST", body, adaptationId ? `${action}:${adaptationId}` : action, { agentId, definitionVersion, adaptation: read.data.adaptations.find((item) => item.adaptationId === adaptationId) });
    if (!token) return;
    setError(undefined);
    try {
      const payload = await agentsActionRequest(token);
      if (!gate.current(token)) return;
      const next = adaptationReceipt(payload, agentId, read.data, body);
      floor.current = next; read.accept(next); setMessage(actionMessage(action));
      gate.finish(token, true);
    } catch (caught) { if (gate.current(token)) setError(messageFrom(caught, "The adaptation action was not confirmed.")); }
    finally { gate.finish(token, false); }
  }
  return (
    <section className={styles.panel} data-compact={compact || undefined} aria-label={`${agentName} adaptation evidence`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary">Learn from corrections</p>
          <h3 className="mt-1 text-sm font-semibold">{agentName}</h3>
        </div>
        <button
          type="button"
          className="secondary-button justify-center"
          disabled={disabled}
          onClick={() => void mutate("refresh")}
        >
          {busy === "refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh evidence
        </button>
      </div>

      <div className={styles.toolbar}><span role="status">{read.label}</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void read.refresh()}>Refresh adaptation status</button></div>
      <p>Agent ID: {agentId}</p>
      {read.error ? <p role="alert">{read.error}</p> : null}
      {reason ? <p>{reason}</p> : null}
      <p className="mt-3 text-xs leading-5 text-muted">
        Corrections suggest guidance. Check eligibility, then compare today’s guidance with the candidate on 3–10 tasks you choose. Activation requires at least one extra passing task with no regressions. This tests text behavior only; it does not prove performance on real workflows.
      </p>

      {definitionVersion ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <Metric label="Release" value={`v${definitionVersion}`} />
          <Metric label="Active" value={String(adaptations.filter((item) => item.state === "active").length)} />
          <Metric label="Observed" value={String(adaptations.filter((item) => item.state === "observed").length)} />
        </div>
      ) : null}

      {!read.data && read.loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading adaptation evidence…</p>
      ) : adaptations.length ? (
        <div className="mt-4 grid gap-3">
          {adaptations.map((adaptation) => (
            <AdaptationCard
              key={adaptation.adaptationId}
              adaptation={adaptation}
              currentDefinitionVersion={definitionVersion || 0}
              busy={disabled}
              onAction={(action, suite) => void mutate(action, adaptation.adaptationId, suite)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs leading-5 text-muted">
          {read.data ? "No correction evidence is waiting in this snapshot. Refresh evidence checks completed runs owned by you; it does not activate anything." : "Adaptation evidence is unavailable. No empty or active count has been confirmed."}
        </div>
      )}

      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-primary" role="status">{message}</p> : null}
    </section>
  );
}

function AdaptationCard({
  adaptation,
  currentDefinitionVersion,
  busy,
  onAction,
}: {
  adaptation: AgentAdaptationV1;
  currentDefinitionVersion: number;
  busy: boolean;
  onAction: (action: "evaluate" | "compare" | "activate" | "rollback", suite?: AdaptationComparisonSuite) => void;
}) {
  const action = agentAdaptationAction(adaptation, currentDefinitionVersion);
  return (
    <article className="rounded-lg border border-border/70 bg-background/55 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-full px-2 py-1 text-xs font-bold uppercase tracking-[0.08em] ${stateStyle(adaptation.state)}`}>
          {adaptation.state.replace("_", " ")}
        </span>
        <span className="text-xs font-semibold text-muted">{Math.round(adaptation.confidence * 100)}% evidence confidence</span>
      </div>
      <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-sm leading-6">
        {adaptation.effect.guidance}
      </blockquote>
      <div className="mt-3 grid gap-1 text-xs leading-5 text-muted">
        <span><Activity size={12} className="mr-1 inline" /> {adaptation.evidence.length} evidence item{adaptation.evidence.length === 1 ? "" : "s"} · {adaptation.evidence.map((item) => item.kind.replace("_", " ")).join(", ")}</span>
        <span><ShieldCheck size={12} className="mr-1 inline" /> Observed on release v{adaptation.observedDefinitionVersion} · authority impact: none</span>
        {adaptation.evaluation ? (
          <span><FlaskConical size={12} className="mr-1 inline" /> Eligibility {adaptation.evaluation.verdict} · {adaptation.evaluation.policyVersionId} · release v{adaptation.evaluation.definitionVersion}</span>
        ) : (
          <span><FlaskConical size={12} className="mr-1 inline" /> Eligibility not checked</span>
        )}
        {adaptation.activationVersion ? (
          <span><CheckCircle2 size={12} className="mr-1 inline" /> Activation v{adaptation.activationVersion}{adaptation.rolledBackAt ? " · rolled back" : ""}</span>
        ) : null}
      </div>
      <details className={styles.evidence}>
        <summary>Exact adaptation and evidence</summary>
        <dl className={styles.identity}><dt>Agent ID</dt><dd>{adaptation.agentId}</dd><dt>Adaptation ID</dt><dd>{adaptation.adaptationId}</dd><dt>Owner binding</dt><dd>{adaptation.ownerBindingSha256}</dd><dt>Evidence digest</dt><dd>{adaptation.evidenceSha256}</dd><dt>Effect digest</dt><dd>{adaptation.effect.effectSha256}</dd>{adaptation.evaluation ? <><dt>Evaluation digest</dt><dd>{adaptation.evaluation.evaluationSha256}</dd></> : null}</dl>
        {adaptation.evidence.map((item) => <dl className={styles.identity} key={item.evidenceId}><dt>Evidence ID</dt><dd>{item.evidenceId}</dd><dt>Source ID</dt><dd>{item.sourceId}</dd><dt>Source digest</dt><dd>{item.sourceSha256}</dd><dt>Verdict</dt><dd>{item.verdict} · {item.groundingStatus}</dd><dt>Observed</dt><dd>{item.observedAt}</dd></dl>)}
      </details>
      {adaptation.comparison ? <ComparisonResult adaptation={adaptation} /> : null}
      {action.kind === "compare" ? <ComparisonForm busy={busy} initial={adaptation.comparison?.suite} onCompare={(suite) => onAction("compare", suite)} /> : action.kind === "blocked" ? (
        <p className="mt-3 rounded-md bg-muted/35 px-3 py-2 text-xs leading-5 text-muted">{action.reason}</p>
      ) : (
        <button
          type="button"
          className={action.kind === "activate" ? "primary-button mt-3 w-full justify-center" : "secondary-button mt-3 w-full justify-center"}
          disabled={busy}
          onClick={() => onAction(action.kind)}
        >
          {action.kind === "rollback" ? <RotateCcw size={14} /> : action.kind === "evaluate" ? <FlaskConical size={14} /> : <CheckCircle2 size={14} />}
          {action.label}
        </button>
      )}
      {action.kind === "activate" ? (
        <details className="mt-3 text-sm">
          <summary>Run a new comparison</summary>
          <p className="mt-2 text-xs text-muted">Compare again if the model or active guidance has changed. Each new comparison can incur model charges.</p>
          <ComparisonForm busy={busy} initial={adaptation.comparison?.suite} onCompare={(suite) => onAction("compare", suite)} />
        </details>
      ) : null}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-muted/30 px-2 py-2"><strong className="block text-sm">{value}</strong><span className="text-muted">{label}</span></div>;
}

function stateStyle(state: AgentAdaptationV1["state"]) {
  return state === "active"
    ? "bg-success/10 text-success"
    : state === "evaluated"
      ? "bg-primary/10 text-primary"
      : state === "rolled_back"
        ? "bg-muted text-muted"
        : "bg-warning/10 text-warning";
}

function actionMessage(action: "refresh" | "evaluate" | "compare" | "activate" | "rollback") {
  return action === "refresh"
    ? "Correction evidence refreshed. Nothing was activated."
    : action === "evaluate"
      ? "Eligibility checked. A real text comparison is still required."
      : action === "compare" ? "Comparison recorded. Review the task results before activating."
      : action === "activate"
        ? "Adaptation activated with a numbered version."
        : "Adaptation rolled back. It no longer affects new runs.";
}

function messageFrom(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function ComparisonForm({ busy, initial, onCompare }: { busy: boolean; initial?: AdaptationComparisonSuite; onCompare: (suite: AdaptationComparisonSuite) => void }) {
  const blank = (index: number) => ({ id: `case-${index}`, task: "", assertions: { allOf: [] as string[], noneOf: [] as string[], minLength: 1, maxLength: 2000 } });
  const [cases, setCases] = useState(() => initial?.cases || [blank(1), blank(2), blank(3)]);
  const [error, setError] = useState<string>();
  const update = (index: number, patch: Partial<AdaptationComparisonSuite["cases"][number]>) => setCases((old) => old.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); const parsed = adaptationComparisonSuiteSchema.safeParse({ cases: cases.map((row) => ({ ...row, assertions: { ...row.assertions, allOf: row.assertions.allOf.filter((phrase) => phrase.trim()), noneOf: row.assertions.noneOf.filter((phrase) => phrase.trim()) } })) }); if (!parsed.success) { setError(parsed.error.issues[0]?.message || "Check the tasks and assertions."); return; } setError(undefined); onCompare(parsed.data); }}>
    <p className="text-xs leading-5">Choose independent examples, including cases that already work. Only the task goes to the model; your checks stay with the deterministic scorer. Each task calls the configured model twice, up to 20 calls and two minutes. Provider charges apply; unknown cost stays unknown.</p>
    {cases.map((row, index) => <fieldset key={row.id} disabled={busy} className="grid gap-2 rounded border border-border p-3">
      <legend>Example {index + 1}</legend>
      <label className="grid gap-1 text-xs">Task<textarea className="input min-h-20" value={row.task} minLength={10} maxLength={2000} required onChange={(e) => update(index, { task: e.target.value })} /></label>
      <label className="grid gap-1 text-xs">Must include (one phrase per line, up to 5)<textarea className="input" value={row.assertions.allOf.join("\n")} onChange={(e) => update(index, { assertions: { ...row.assertions, allOf: e.target.value.split("\n") } })} /></label>
      <label className="grid gap-1 text-xs">Must avoid (one phrase per line, up to 5)<textarea className="input" value={row.assertions.noneOf.join("\n")} onChange={(e) => update(index, { assertions: { ...row.assertions, noneOf: e.target.value.split("\n") } })} /></label>
      <div className="flex flex-wrap gap-3"><label className="grid gap-1 text-xs">Minimum characters<input type="number" min={1} max={8000} required value={row.assertions.minLength} onChange={(e) => update(index, { assertions: { ...row.assertions, minLength: Number(e.target.value) } })} /></label><label className="grid gap-1 text-xs">Maximum characters<input type="number" min={1} max={8000} required value={row.assertions.maxLength} onChange={(e) => update(index, { assertions: { ...row.assertions, maxLength: Number(e.target.value) } })} /></label></div>
      {cases.length > 3 ? <button type="button" className="secondary-button" onClick={() => setCases((old) => old.filter((_, i) => i !== index))}>Remove example</button> : null}
    </fieldset>)}
    {error ? <p role="alert">{error}</p> : null}
    {cases.length < 10 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => setCases((old) => [...old, blank(Math.max(...old.map((row) => Number(row.id.split("-").at(-1)) || 0)) + 1)])}>Add example</button> : null}
    <button className="primary-button justify-center" disabled={busy} type="submit">{busy ? "Comparison or another action is in progress…" : `Run ${cases.length * 2} model calls and compare`}</button>
    <p className="text-xs">Phrase matching ignores case. Length counts Unicode characters. If the connection is interrupted, refresh status; the accepted request will not be repeated automatically.</p>
  </form>;
}
function ComparisonResult({ adaptation }: { adaptation: AgentAdaptationV1 }) {
  const comparison = adaptation.comparison!;
  return <section className="mt-3 rounded border border-border p-3" aria-label="Text comparison results">
    <p className="font-semibold">{comparison.verdict.replaceAll("_", " ")}: {comparison.baselinePassed}/{comparison.results.length} → {comparison.candidatePassed}/{comparison.results.length} tasks passed</p>
    <p className="text-xs">{comparison.pins.runtime.provider} · {comparison.pins.runtime.model} · {comparison.costUsd === null ? "Cost unknown" : `$${comparison.costUsd.toFixed(4)} estimated`} · {new Date(comparison.completedAt).toLocaleString()}</p>
    {comparison.verdict === "no_change" ? <p>A tie does not establish improvement.</p> : comparison.verdict === "incomplete" ? <p>Some calls or configuration checks were not confirmed. This comparison cannot activate guidance.</p> : comparison.verdict === "regressed" ? <p>A previously passing task regressed. This comparison cannot activate guidance.</p> : <p>Improved on your chosen examples. Review the outputs; these checks do not establish broader reliability. Activation expires after 24 hours or a configuration change.</p>}
    {comparison.results.map((row, i) => <details key={row.caseId} className="mt-2"><summary>Example {i + 1}: baseline {row.baselinePassed ? "passed" : row.baseline.status === "completed" ? "failed checks" : row.baseline.status}; candidate {row.candidatePassed ? "passed" : row.candidate.status === "completed" ? "failed checks" : row.candidate.status}</summary><p className="whitespace-pre-wrap">{comparison.suite.cases[i].task}</p><p>Baseline</p><pre className="whitespace-pre-wrap text-xs">{row.baseline.output || row.baseline.failure || "Not run"}</pre><p>Candidate</p><pre className="whitespace-pre-wrap text-xs">{row.candidate.output || row.candidate.failure || "Not run"}</pre></details>)}
  </section>;
}
