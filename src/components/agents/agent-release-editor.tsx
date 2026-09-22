"use client";

import {
  Archive,
  CheckCircle2,
  FlaskConical,
  History,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentReleaseEvaluationV1,
} from "@/lib/agents/release-contracts";
import type { AgentReleaseView } from "@/lib/agents/release-store";

export type AgentReleaseSelectionAction =
  | Readonly<{ kind: "evaluate"; definitionVersion: number }>
  | Readonly<{
      kind: "promote" | "rollback";
      evaluationId: string;
      evaluation: AgentReleaseEvaluationV1;
    }>;

export type AgentReleasePinMetadata = Readonly<{
  activeDefinitionVersionId: string;
  selectedDefinitionVersionId: string | null;
  selectedDefinitionSha256: string | null;
  evaluationId: string | null;
  evaluationSha256: string | null;
}>;

export function agentReleaseMatchesAgent(
  release: AgentReleaseView | undefined,
  agentId: string,
) {
  return release?.agentId === agentId;
}

export function agentReleasePinMetadata(
  release: AgentReleaseView,
  definitionVersion?: number,
): AgentReleasePinMetadata {
  const selected = definitionVersion === undefined
    ? undefined
    : release.versions.find((version) => version.definitionVersion === definitionVersion);
  const evaluation = definitionVersion === undefined
    ? undefined
    : release.evaluations.find((candidate) =>
        candidate.definitionVersion === definitionVersion &&
        candidate.baselineDefinitionVersion === release.activeDefinitionVersion
      ) || release.evaluations.find((candidate) =>
        candidate.definitionVersion === definitionVersion
      );
  return Object.freeze({
    activeDefinitionVersionId: release.activeDefinitionVersionId,
    selectedDefinitionVersionId: selected?.definitionVersionId || null,
    selectedDefinitionSha256: evaluation?.definitionSha256 || null,
    evaluationId: evaluation?.evaluationId || null,
    evaluationSha256: evaluation?.evaluationSha256 || null,
  });
}

export function agentReleaseActionForSelection(
  release: AgentReleaseView,
  definitionVersion: number,
): AgentReleaseSelectionAction | undefined {
  if (
    release.state !== "active" ||
    definitionVersion === release.activeDefinitionVersion ||
    !release.versions.some((version) =>
      version.definitionVersion === definitionVersion
    )
  ) return undefined;
  const evaluation = release.evaluations.find((candidate) =>
    candidate.definitionVersion === definitionVersion &&
    candidate.baselineDefinitionVersion === release.activeDefinitionVersion
  );
  return evaluation
    ? {
        kind: evaluation.direction === "promotion" ? "promote" : "rollback",
        evaluationId: evaluation.evaluationId,
        evaluation,
      }
    : { kind: "evaluate", definitionVersion };
}

export function AgentReleaseEditor({
  agentId,
  agentName,
  compact = false,
}: {
  agentId: string;
  agentName: string;
  compact?: boolean;
}) {
  const [release, setRelease] = useState<AgentReleaseView>();
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireConfirmation, setRetireConfirmation] = useState("");
  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRelease(undefined);
      setSelectedVersion(undefined);
      setLoading(true);
      setBusy(undefined);
      setError(undefined);
      setMessage(undefined);
      setRetireOpen(false);
      setRetireConfirmation("");
      void requestRelease(agentId, undefined, controller.signal)
        .then((next) => {
          if (
            generation !== loadGeneration.current ||
            next.agentId !== agentId
          ) return;
          setRelease(next);
          setSelectedVersion(suggestedVersion(next));
        })
        .catch((caught) => {
          if (controller.signal.aborted || generation !== loadGeneration.current) return;
          setError(messageFrom(caught, "Release history could not be loaded."));
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

  const action = useMemo(() => release && selectedVersion
    ? agentReleaseActionForSelection(release, selectedVersion)
    : undefined, [release, selectedVersion]);

  async function mutate(
    key: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    const mutationAgentId = agentId;
    if (!agentReleaseMatchesAgent(release, mutationAgentId)) {
      setError("The selected Agent changed. Reload its release before making changes.");
      return;
    }
    setBusy(key);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await requestRelease(mutationAgentId, body);
      if (next.agentId !== mutationAgentId) return;
      setRelease(next);
      setSelectedVersion(suggestedVersion(next));
      setMessage(successMessage);
      setRetireOpen(false);
      setRetireConfirmation("");
    } catch (caught) {
      setError(messageFrom(caught, "The release action could not be completed."));
    } finally {
      setBusy(undefined);
    }
  }

  if (loading || (release !== undefined && !agentReleaseMatchesAgent(release, agentId))) {
    return <ReleaseShell compact={compact}><p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading release history…</p></ReleaseShell>;
  }
  if (!release) {
    return <ReleaseShell compact={compact}><p className="text-sm text-danger" role="alert">{error || "Release history is unavailable."}</p></ReleaseShell>;
  }
  const selected = release.versions.find((version) =>
    version.definitionVersion === selectedVersion
  );
  const pinMetadata = agentReleasePinMetadata(release, selectedVersion);
  return (
    <ReleaseShell compact={compact}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">Release lifecycle</p>
          <h3 className="mt-1 text-sm font-semibold">{agentName}</h3>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${release.state === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
          {release.state}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
        <ReleaseMetric label="Active" value={`v${release.activeDefinitionVersion}`} />
        <ReleaseMetric label="Latest" value={`v${release.latestDefinitionVersion}`} />
        <ReleaseMetric label="Revision" value={String(release.releaseRevision)} />
      </div>

      <p className="mt-3 text-xs leading-5 text-muted">
        Edits create an immutable draft. New work keeps using the active version until an exact evaluation is promoted; existing runs remain pinned.
      </p>

      <dl className="mt-3 grid gap-2 rounded-lg border border-border/70 bg-background/55 p-3 text-[10px]" aria-label="Exact release pins">
        <ReleasePin label="Active version ID" value={pinMetadata.activeDefinitionVersionId} />
        {pinMetadata.selectedDefinitionVersionId ? <ReleasePin label="Selected version ID" value={pinMetadata.selectedDefinitionVersionId} /> : null}
        {pinMetadata.selectedDefinitionSha256 ? <ReleasePin label="Definition digest" value={pinMetadata.selectedDefinitionSha256} /> : (
          <div className="text-muted">The read model exposes this version&apos;s exact ID. Its definition digest appears after evaluation.</div>
        )}
        {pinMetadata.evaluationId ? <ReleasePin label="Evaluation ID" value={pinMetadata.evaluationId} /> : null}
        {pinMetadata.evaluationSha256 ? <ReleasePin label="Evaluation digest" value={pinMetadata.evaluationSha256} /> : null}
      </dl>

      {release.state === "active" && release.versions.length > 1 ? (
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1.5 text-xs font-medium">
            Review version
            <select
              value={selectedVersion || ""}
              onChange={(event) => setSelectedVersion(Number(event.currentTarget.value))}
              className="min-h-10 rounded-md border border-border bg-background px-3 text-sm"
            >
              {release.versions.filter((version) => !version.active).map((version) => (
                <option key={version.definitionVersion} value={version.definitionVersion}>
                  v{version.definitionVersion} · {version.definitionVersion > release.activeDefinitionVersion ? "draft" : "rollback target"}
                </option>
              ))}
            </select>
          </label>
          {action?.kind === "evaluate" ? (
            <button
              type="button"
              className="secondary-button justify-center"
              disabled={Boolean(busy)}
              onClick={() => void mutate(
                `evaluate:${action.definitionVersion}`,
                { action: "evaluate", definitionVersion: action.definitionVersion },
                `Version ${action.definitionVersion} passed the release contract evaluation.`,
              )}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
              Evaluate v{action.definitionVersion}
            </button>
          ) : action ? (
            <div className="rounded-lg border border-success/25 bg-success/5 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-success">
                <CheckCircle2 size={14} /> Evaluation passed
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                {action.evaluation.changedFields.map((field) => field.replaceAll("_", " ")).join(", ")} changed · evaluated {formatDate(action.evaluation.evaluatedAt)}
              </p>
              <button
                type="button"
                className="primary-button mt-3 w-full justify-center"
                disabled={Boolean(busy)}
                onClick={() => void mutate(
                  action.kind,
                  { action: action.kind, evaluationId: action.evaluationId },
                  action.kind === "promote"
                    ? `Version ${selected?.definitionVersion} is now active.`
                    : `Rolled back atomically to version ${selected?.definitionVersion}.`,
                )}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : action.kind === "rollback" ? <RotateCcw size={14} /> : <CheckCircle2 size={14} />}
                {action.kind === "rollback" ? "Roll back" : "Promote"} v{selected?.definitionVersion}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {release.state === "active" ? (
        <div className="mt-4 border-t border-border/70 pt-4">
          {!retireOpen ? (
            <button type="button" className="text-xs font-semibold text-danger" onClick={() => setRetireOpen(true)}>
              <Archive size={13} className="mr-1 inline" /> Retire Agent
            </button>
          ) : (
            <div className="grid gap-2">
              <p className="text-xs leading-5 text-muted">Retirement is terminal and blocks new runs. Type <strong>RETIRE AGENT</strong> to confirm.</p>
              <input
                value={retireConfirmation}
                onChange={(event) => setRetireConfirmation(event.currentTarget.value)}
                className="min-h-10 rounded-md border border-danger/40 bg-background px-3 text-sm"
                aria-label="Retirement confirmation"
              />
              <div className="flex gap-2">
                <button type="button" className="secondary-button flex-1 justify-center" onClick={() => { setRetireOpen(false); setRetireConfirmation(""); }}>Cancel</button>
                <button
                  type="button"
                  className="secondary-button flex-1 justify-center text-danger"
                  disabled={Boolean(busy) || retireConfirmation !== "RETIRE AGENT"}
                  onClick={() => void mutate("retire", { action: "retire", confirmation: retireConfirmation }, `${agentName} is retired.`)}
                >
                  Retire
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 flex items-center gap-2 rounded-lg bg-warning/5 p-3 text-xs leading-5 text-warning">
          <History size={14} /> Historical versions and run evidence are retained. This Agent cannot accept new work.
        </p>
      )}

      {message ? <p className="mt-3 text-xs text-success" role="status">{message}</p> : null}
      {error ? <p className="mt-3 text-xs text-danger" role="alert">{error}</p> : null}
    </ReleaseShell>
  );
}

function ReleaseShell({ compact, children }: {
  compact: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`${compact ? "rounded-xl" : "rounded-2xl"} border border-border/70 bg-surface-raised/35 p-4`} aria-label="Agent release lifecycle">
      {children}
    </section>
  );
}

function ReleaseMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-background/70 p-2"><strong className="block text-sm">{value}</strong><span className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</span></div>;
}

function ReleasePin({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><dt className="text-muted">{label}</dt><dd className="m-0 break-all font-mono text-foreground" title={value}>{value}</dd></div>;
}

function suggestedVersion(release: AgentReleaseView) {
  if (release.latestDefinitionVersion !== release.activeDefinitionVersion) {
    return release.latestDefinitionVersion;
  }
  return release.previousDefinitionVersion ||
    release.versions.filter((version) => !version.active).at(-1)?.definitionVersion;
}

async function requestRelease(
  agentId: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/release`,
    {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    },
  );
  const payload = await response.json().catch(() => ({})) as {
    release?: AgentReleaseView;
    error?: string;
  };
  if (!response.ok || !payload.release) {
    throw new Error(payload.error || "The Agent release request failed.");
  }
  return payload.release;
}

function messageFrom(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
