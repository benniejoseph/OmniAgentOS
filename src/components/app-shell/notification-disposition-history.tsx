"use client";

import {
  BellOff,
  Clock3,
  Layers3,
  Loader2,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export type NotificationDispositionView = Readonly<{
  dispositionId: string;
  sourceKind: string;
  outcome: "send" | "defer" | "digest" | "suppress";
  state: "pending" | "terminal";
  reason: string;
  mustSend: boolean;
  critical: boolean;
  decisionReceiptSha256: string;
  evaluatedAt: string;
  dueAt: string | null;
  deliveryKind: string | null;
  deliveryBindingSha256: string | null;
  updatedAt: string;
  terminalAt: string | null;
  contentIncluded: false;
}>;

type HistoryState = "idle" | "loading" | "ready" | "error";

export function NotificationDispositionHistory({ active }: { active: boolean }) {
  const [state, setState] = useState<HistoryState>("idle");
  const [dispositions, setDispositions] = useState<readonly NotificationDispositionView[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!active || state !== "idle") return;
    const controller = new AbortController();
    void fetch("/api/notifications/dispositions?limit=24", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as {
        dispositions?: NotificationDispositionView[];
        contentIncluded?: boolean;
        error?: string;
      };
      if (!response.ok || !Array.isArray(payload.dispositions) || payload.contentIncluded !== false) {
        throw new Error(payload.error || "Delivery decision history could not be loaded.");
      }
      return payload.dispositions;
    }).then((next) => {
      if (controller.signal.aborted) return;
      setDispositions(next);
      setState("ready");
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Delivery decision history could not be loaded.");
      setState("error");
    });
    return () => controller.abort();
  }, [active, state]);

  if (!active) return null;
  return <NotificationDispositionHistoryView state={state === "idle" ? "loading" : state} dispositions={dispositions} error={error} />;
}

export function NotificationDispositionHistoryView({
  state,
  dispositions,
  error,
}: {
  state: Exclude<HistoryState, "idle">;
  dispositions: readonly NotificationDispositionView[];
  error?: string;
}) {
  return (
    <section className="notification-decision-history" aria-labelledby="notification-decisions-title">
      <div className="notification-section-title">
        <div>
          <h3 id="notification-decisions-title">Delivery decisions</h3>
          <small>Why proactive alerts were sent, held, grouped, or skipped</small>
        </div>
        {state === "ready" ? <span>{dispositions.length}</span> : null}
      </div>
      <p className="notification-decision-boundary"><ShieldCheck size={13} aria-hidden="true" />This history is content-free. It records policy outcomes and receipt digests, never notification text.</p>
      {state === "loading" ? <div className="notification-decision-state" aria-busy="true"><Loader2 size={15} className="animate-spin" />Loading policy decisions…</div> : null}
      {state === "error" ? <div className="notification-decision-state is-error" role="alert">{error || "Delivery decision history is unavailable."}</div> : null}
      {state === "ready" && !dispositions.length ? <div className="notification-decision-state">No proactive delivery decisions have been recorded yet.</div> : null}
      {state === "ready" && dispositions.length ? (
        <div className="notification-decision-list">
          {dispositions.map((item) => (
            <article key={item.dispositionId} data-outcome={item.outcome}>
              <span className="notification-decision-icon" aria-hidden="true">{outcomeIcon(item.outcome)}</span>
              <div>
                <header><strong>{outcomeLabel(item.outcome)}</strong><time>{formatDecisionTime(item.evaluatedAt)}</time></header>
                <p>{reasonCopy(item.reason, item.outcome)}</p>
                <dl>
                  <div><dt>Source</dt><dd>{sourceLabel(item.sourceKind)}</dd></div>
                  <div><dt>State</dt><dd>{item.state === "terminal" ? "Finished" : "Waiting"}</dd></div>
                  {item.dueAt ? <div><dt>Due</dt><dd>{formatDecisionTime(item.dueAt)}</dd></div> : null}
                  <div><dt>Decision receipt</dt><dd title={item.decisionReceiptSha256}>{shortDigest(item.decisionReceiptSha256)}</dd></div>
                  {item.deliveryBindingSha256 ? <div><dt>Delivery binding</dt><dd title={item.deliveryBindingSha256}>{shortDigest(item.deliveryBindingSha256)}</dd></div> : null}
                </dl>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function outcomeIcon(outcome: NotificationDispositionView["outcome"]): ReactNode {
  if (outcome === "send") return <Send size={13} />;
  if (outcome === "defer") return <Clock3 size={13} />;
  if (outcome === "digest") return <Layers3 size={13} />;
  return <BellOff size={13} />;
}

function outcomeLabel(outcome: NotificationDispositionView["outcome"]) {
  return ({ send: "Sent directly", defer: "Held until later", digest: "Grouped into a digest", suppress: "Skipped" } as const)[outcome];
}

function reasonCopy(reason: string, outcome: NotificationDispositionView["outcome"]) {
  return ({
    approval_required: "An approval needs a person to decide.",
    security_alert: "A security warning met the alert policy.",
    actionable_failure: "A failed task needs a person to act.",
    meeting_imminent: "A meeting is close enough to need a reminder.",
    critical_delivery: "A critical alert bypassed normal holding rules.",
    quiet_hours: "Quiet hours delayed a required alert.",
    cooldown_active: "A recent alert started a short cooldown.",
    digest_nonurgent: "Non-urgent information was grouped to reduce interruption.",
    digest_during_cooldown: "A cooldown grouped this non-critical alert.",
    routine_success: "Routine success did not require an interruption.",
    failure_not_actionable: "The failure had no action for you to take.",
    meeting_not_imminent: "The meeting is not close enough for an alert.",
    not_worthy: "The event did not meet the proactive alert threshold.",
  } as Record<string, string>)[reason] || `Policy recorded this alert as ${outcomeLabel(outcome).toLowerCase()}.`;
}

function sourceLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortDigest(value: string) {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "Unavailable";
}

function formatDecisionTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
