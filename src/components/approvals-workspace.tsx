"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { clsx } from "clsx";

type JsonRecord = Record<string, unknown>;

type ApprovalItem = {
  kind: "tool" | "workflow" | "slo_policy";
  id: string;
  title: string;
  status: string;
  riskLevel: number;
  requestedBy?: string;
  reason?: string;
  createdAt: string;
  input?: JsonRecord;
};

type QueueResponse = {
  items: ApprovalItem[];
  stats: { total: number; tools: number; workflows: number; sloPolicies: number };
};

export function ApprovalsWorkspace() {
  const [queue, setQueue] = useState<QueueResponse>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [decisionInFlight, setDecisionInFlight] = useState<string>();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [lastDecision, setLastDecision] = useState<string>();

  async function load() {
    setState("loading");
    setError(undefined);
    try {
      const response = await fetch("/api/approvals?limit=50");
      const body = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        throw new Error(String(body.message || body.error || `Approvals returned ${response.status}`));
      }
      setQueue(body as unknown as QueueResponse);
      setState("ready");
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Approvals unavailable.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function decide(item: ApprovalItem, decision: "approve" | "reject") {
    setDecisionInFlight(`${item.id}:${decision}`);
    setError(undefined);
    try {
      const response = await fetch(`/api/approvals/${item.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: item.kind, decision, reason: reasons[item.id] || undefined }),
      });
      const body = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        throw new Error(String(body.message || body.error || `Decision failed (${response.status}).`));
      }
      setLastDecision(`${decision === "approve" ? "Approved" : "Rejected"}: ${item.title}`);
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      setDecisionInFlight(undefined);
    }
  }

  const items = useMemo(() => queue?.items || [], [queue]);

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-xl font-semibold">Approvals</h1>
              <p className="mt-1 text-sm text-muted">
                Nothing here executes until you say so. Each card explains what will happen if you approve.
              </p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} className="action-button" disabled={state === "loading"}>
            {state === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            Refresh
          </button>
        </div>
        {queue ? (
          <p className="mt-4 text-sm text-muted">
            {queue.stats.total ? (
              <>
                <span className="font-semibold text-foreground">{queue.stats.total} pending</span>
                {" — "}
                {queue.stats.tools} tool {queue.stats.tools === 1 ? "call" : "calls"}, {queue.stats.workflows}{" "}
                {queue.stats.workflows === 1 ? "workflow" : "workflows"}, {queue.stats.sloPolicies} policy{" "}
                {queue.stats.sloPolicies === 1 ? "change" : "changes"}.
              </>
            ) : (
              "Nothing is waiting for you. Agent and workflow runs will pause here when they need permission."
            )}
          </p>
        ) : null}
      </section>

      {lastDecision ? (
        <p className="mt-4 rounded-md border border-success/40 bg-success/10 px-4 py-2 text-sm" role="status">
          {lastDecision}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mt-4 space-y-4">
        {state === "loading" && !queue ? (
          <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">Loading the approval queue…</div>
        ) : null}
        {state === "ready" && !items.length ? (
          <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
            No pending approvals. When an agent or workflow needs permission for a side-effecting action, it appears here.
          </div>
        ) : null}
        {items.map((item) => (
          <ApprovalCard
            key={`${item.kind}-${item.id}`}
            item={item}
            reason={reasons[item.id] || ""}
            onReason={(value) => setReasons((current) => ({ ...current, [item.id]: value }))}
            onDecide={(decision) => void decide(item, decision)}
            inFlight={decisionInFlight?.startsWith(item.id) ? decisionInFlight.split(":")[1] : undefined}
          />
        ))}
      </section>
    </div>
  );
}

function ApprovalCard({
  item,
  reason,
  onReason,
  onDecide,
  inFlight,
}: {
  item: ApprovalItem;
  reason: string;
  onReason: (value: string) => void;
  onDecide: (decision: "approve" | "reject") => void;
  inFlight?: string;
}) {
  return (
    <article className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{item.title}</h2>
            <span className="rounded-md border border-line bg-background px-2 py-0.5 font-mono text-xs text-muted">{kindLabel(item.kind)}</span>
            <span className={clsx("rounded-md px-2 py-0.5 font-mono text-xs", riskPill(item.riskLevel))}>risk {item.riskLevel}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Requested {formatTime(item.createdAt)}
            {item.requestedBy ? ` by ${item.requestedBy}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <ConsentFact label="If you approve" value={whatWillHappen(item)} />
        <ConsentFact label="Reversibility" value={reversibility(item.riskLevel)} />
        <ConsentFact label="Why it is waiting" value={item.reason || "This action requires human approval by policy."} />
      </div>

      {item.input && Object.keys(item.input).length ? (
        <details className="mt-4 rounded-md border border-line bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">Exact inputs (secrets redacted)</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted">{JSON.stringify(item.input, null, 2)}</pre>
        </details>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          placeholder="Optional decision note (recorded in the audit trail)"
          className="h-10 min-w-0 flex-1 rounded-md border border-line bg-background px-3 text-sm placeholder:text-muted"
          aria-label="Decision reason"
        />
        <button type="button" onClick={() => onDecide("reject")} disabled={Boolean(inFlight)} className="action-button">
          {inFlight === "reject" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
          Reject
        </button>
        <button type="button" onClick={() => onDecide("approve")} disabled={Boolean(inFlight)} className="primary-button">
          {inFlight === "approve" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          Approve and run
        </button>
      </div>
    </article>
  );
}

function ConsentFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-background p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 text-sm leading-5">{value}</p>
    </div>
  );
}

function kindLabel(kind: ApprovalItem["kind"]) {
  if (kind === "tool") {
    return "tool call";
  }
  return kind === "workflow" ? "workflow gate" : "SLO policy";
}

function whatWillHappen(item: ApprovalItem) {
  if (item.kind === "tool") {
    return `The ${item.title} tool executes for real with the inputs below, and the output is recorded in the tool audit ledger.`;
  }
  if (item.kind === "workflow") {
    return "The paused workflow resumes and continues executing its remaining plan steps.";
  }
  return "The monitoring policy change is applied and starts affecting SLO evaluation, incidents, and alerts.";
}

function reversibility(riskLevel: number) {
  if (riskLevel <= 1) {
    return "Low impact — writes to internal stores that can be edited or removed afterwards.";
  }
  if (riskLevel === 2) {
    return "Side-effecting — may reach external systems and may not be reversible. Review the inputs first.";
  }
  return "High impact — requires two distinct admin approvals (the requester cannot approve their own request).";
}

function riskPill(riskLevel: number) {
  if (riskLevel <= 1) {
    return "bg-success/10 text-success";
  }
  return riskLevel === 2 ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger";
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
