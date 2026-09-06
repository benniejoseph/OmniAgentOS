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
import { useEffect, useRef, useState } from "react";

import type { AgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";

type AdaptationAction =
  | Readonly<{ kind: "evaluate" | "activate" | "rollback"; label: string }>
  | Readonly<{ kind: "blocked"; reason: string }>;

type AdaptationResponse = Readonly<{
  adaptations: AgentAdaptationV1[];
  definitionVersion: number;
}>;

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
    return { kind: "evaluate", label: "Evaluate" };
  }
  if (adaptation.evaluation?.verdict === "held") {
    return {
      kind: "blocked",
      reason: "Held because the measurable confidence threshold was not met.",
    };
  }
  if (adaptation.evaluation?.definitionVersion !== currentDefinitionVersion) {
    return {
      kind: "blocked",
      reason: `Evaluated on release v${adaptation.evaluation?.definitionVersion}. Refresh evidence for v${currentDefinitionVersion}.`,
    };
  }
  return { kind: "activate", label: "Activate" };
}

export function AgentAdaptationEditor({
  agentId,
  agentName,
  compact = false,
}: {
  agentId: string;
  agentName: string;
  compact?: boolean;
}) {
  const [adaptations, setAdaptations] = useState<AgentAdaptationV1[]>([]);
  const [definitionVersion, setDefinitionVersion] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(undefined);
      void requestAdaptations(agentId, undefined, controller.signal)
        .then((payload) => {
          if (generation !== loadGeneration.current) return;
          setAdaptations(payload.adaptations);
          setDefinitionVersion(payload.definitionVersion);
        })
        .catch((caught) => {
          if (controller.signal.aborted || generation !== loadGeneration.current) return;
          setError(messageFrom(caught, "Adaptation evidence could not be loaded."));
        })
        .finally(() => {
          if (generation === loadGeneration.current) setLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [agentId]);

  async function mutate(
    action: "refresh" | "evaluate" | "activate" | "rollback",
    adaptationId?: string,
  ) {
    const key = adaptationId ? `${action}:${adaptationId}` : action;
    setBusy(key);
    setError(undefined);
    setMessage(undefined);
    try {
      const payload = await requestAdaptations(agentId, {
        action,
        ...(adaptationId ? { adaptationId } : {}),
      });
      setAdaptations(payload.adaptations);
      setDefinitionVersion(payload.definitionVersion);
      setMessage(actionMessage(action));
    } catch (caught) {
      setError(messageFrom(caught, "The adaptation action could not be completed."));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className={`${compact ? "rounded-lg" : "rounded-xl"} border border-border/70 bg-surface-raised/45 p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Evidence-gated adaptation</p>
          <h3 className="mt-1 text-sm font-semibold">{agentName}</h3>
        </div>
        <button
          type="button"
          className="secondary-button justify-center"
          disabled={Boolean(busy) || loading}
          onClick={() => void mutate("refresh")}
        >
          {busy === "refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh evidence
        </button>
      </div>

      <p className="mt-3 text-xs leading-5 text-muted">
        Run corrections are observations only. They affect future prompts only after exact-release evaluation and your activation; they never add tools, context, budgets, or authority.
      </p>

      {definitionVersion ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <Metric label="Release" value={`v${definitionVersion}`} />
          <Metric label="Active" value={String(adaptations.filter((item) => item.state === "active").length)} />
          <Metric label="Observed" value={String(adaptations.filter((item) => item.state === "observed").length)} />
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading adaptation evidence…</p>
      ) : adaptations.length ? (
        <div className="mt-4 grid gap-3">
          {adaptations.map((adaptation) => (
            <AdaptationCard
              key={adaptation.adaptationId}
              adaptation={adaptation}
              currentDefinitionVersion={definitionVersion || 0}
              busy={Boolean(busy)}
              onAction={(action) => void mutate(action, adaptation.adaptationId)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs leading-5 text-muted">
          No correction evidence is waiting. Refresh checks completed runs owned by you; it does not activate anything.
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
  onAction: (action: "evaluate" | "activate" | "rollback") => void;
}) {
  const action = agentAdaptationAction(adaptation, currentDefinitionVersion);
  return (
    <article className="rounded-lg border border-border/70 bg-background/55 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${stateStyle(adaptation.state)}`}>
          {adaptation.state.replace("_", " ")}
        </span>
        <span className="text-xs font-semibold text-muted">{Math.round(adaptation.confidence * 100)}% confidence</span>
      </div>
      <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-sm leading-6">
        {adaptation.effect.guidance}
      </blockquote>
      <div className="mt-3 grid gap-1 text-xs leading-5 text-muted">
        <span><Activity size={12} className="mr-1 inline" /> {adaptation.evidence.length} evidence item{adaptation.evidence.length === 1 ? "" : "s"} · {adaptation.evidence.map((item) => item.kind.replace("_", " ")).join(", ")}</span>
        <span><ShieldCheck size={12} className="mr-1 inline" /> Observed on release v{adaptation.observedDefinitionVersion} · authority impact: none</span>
        {adaptation.evaluation ? (
          <span><FlaskConical size={12} className="mr-1 inline" /> {adaptation.evaluation.verdict} · {adaptation.evaluation.policyVersionId} · release v{adaptation.evaluation.definitionVersion}</span>
        ) : (
          <span><FlaskConical size={12} className="mr-1 inline" /> Not evaluated</span>
        )}
        {adaptation.activationVersion ? (
          <span><CheckCircle2 size={12} className="mr-1 inline" /> Activation v{adaptation.activationVersion}{adaptation.rolledBackAt ? " · rolled back" : ""}</span>
        ) : null}
      </div>
      {action.kind === "blocked" ? (
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

function actionMessage(action: "refresh" | "evaluate" | "activate" | "rollback") {
  return action === "refresh"
    ? "Correction evidence refreshed. Nothing was activated."
    : action === "evaluate"
      ? "Evidence evaluated against the current Agent release."
      : action === "activate"
        ? "Adaptation activated with a numbered version."
        : "Adaptation rolled back. It no longer affects new runs.";
}

async function requestAdaptations(
  agentId: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/adaptations`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }
      : { cache: "no-store", signal },
  );
  const payload = (await response.json().catch(() => ({}))) as Partial<AdaptationResponse> & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Request failed.");
  }
  return {
    adaptations: payload.adaptations || [],
    definitionVersion: payload.definitionVersion || 0,
  } satisfies AdaptationResponse;
}

function messageFrom(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}
