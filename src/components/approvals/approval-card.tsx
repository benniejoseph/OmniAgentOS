"use client";

import Link from "next/link";
import { Check, Loader2, MessageSquare, RefreshCw, X } from "lucide-react";
import { clsx } from "clsx";
import {
  isReconciliationItem,
  type ApprovalItem,
  type DecisionNotice,
  type JsonRecord,
  type TrustProfile,
} from "@/components/approvals/approval-decision";

export function ApprovalCard({
  item,
  trust,
  trustEnabled,
  threshold,
  approverRole,
  approverId,
  reason,
  onReason,
  breakGlass,
  onBreakGlass,
  ticket,
  onTicket,
  onDecide,
  inFlight,
  focused = false,
  originHref,
}: {
  item: ApprovalItem;
  trust?: TrustProfile;
  trustEnabled?: boolean;
  threshold?: number;
  approverRole: string;
  approverId?: string;
  reason: string;
  onReason: (value: string) => void;
  breakGlass: boolean;
  onBreakGlass: (value: boolean) => void;
  ticket: string;
  onTicket: (value: string) => void;
  onDecide: (decision: "approve" | "reject") => void;
  inFlight?: string;
  /** The item a link opened the inbox on. */
  focused?: boolean;
  /** The conversation this item paused, when the viewer owns it. */
  originHref?: string;
}) {
  const reconciliationRequired = isReconciliationItem(item);
  const progress = reconciliationRequired ? undefined : approvalProgress(item);
  const approvalPolicy = recordValue(item.input?.approvalPolicy);
  const breakGlassPolicy = recordValue(item.input?.breakGlassPolicy);
  const attestationRequired =
    item.kind === "slo_policy" &&
    Boolean(approvalPolicy.attestationRequired);
  const breakGlassAvailable =
    item.kind === "slo_policy" &&
    Boolean(approvalPolicy.breakGlassAllowed) &&
    Boolean(breakGlassPolicy.enabled);
  const approvalBlockedReason = reconciliationRequired
    ? undefined
    : blockedApprovalReason(
        item,
        approverRole,
        approverId,
        {
          breakGlass,
          breakGlassPolicy,
        },
      );
  const reasonMinimum = breakGlass
    ? Number(breakGlassPolicy.reasonMinLength || 0)
    : attestationRequired
      ? 12
      : 0;
  const ticketRequired =
    breakGlass && Boolean(breakGlassPolicy.requireTicket);
  const approvalFormBlockedReason =
    reason.trim().length < reasonMinimum
      ? breakGlass
        ? `Emergency approval requires at least ${reasonMinimum} characters of rationale.`
        : "This approval requires an attestation of at least 12 characters."
      : ticketRequired && !ticket.trim()
        ? "Emergency approval requires a ticket reference."
        : undefined;
  return (
    <article
      className={clsx(
        "rounded-lg border bg-surface p-5",
        focused ? "border-primary ring-2 ring-primary/35" : "border-line",
      )}
      data-daybook="approval-item"
      data-focused={focused ? "true" : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{item.title}</h3>
            <span className="rounded-md border border-line bg-background px-2 py-0.5 font-mono text-xs text-muted">{kindLabel(item.kind)}</span>
            <span className={clsx("rounded-md px-2 py-0.5 font-mono text-xs", riskPill(item.riskLevel))}>risk {item.riskLevel}</span>
            {reconciliationRequired ? (
              <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                reconciliation required
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">
            Requested {formatTime(item.createdAt)}
            {item.requestedBy ? ` by ${item.requestedBy}` : ""}
          </p>
        </div>
        {originHref ? (
          <Link href={originHref} className="action-link shrink-0">
            <MessageSquare size={14} aria-hidden="true" />
            Open conversation
          </Link>
        ) : null}
      </div>

      {trust && !reconciliationRequired ? <TrackRecord trust={trust} threshold={threshold} enabled={trustEnabled} /> : null}
      {progress ? (
        <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {progress.have}/{progress.need} distinct approvals recorded. This
          action runs only after quorum is reached.
        </p>
      ) : null}
      {item.kind === "workflow" ? (
        <p className="mt-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm leading-5">
          One approval covers repeated reversible actions only when their exact
          inputs are shown below. A changed target, tool contract, action class,
          expired budget, or replanned workflow opens a new approval gate.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <ConsentFact label={reconciliationRequired ? "If you continue" : "If you approve"} value={whatWillHappen(item)} />
        <ConsentFact
          label={reconciliationRequired ? "Authority" : "Reversibility"}
          value={
            reconciliationRequired
              ? "No new approval is granted. The original tenant, actor, input, and approval bindings remain unchanged."
              : reversibility(item)
          }
        />
        <ConsentFact label="Why it is waiting" value={item.reason || "This action requires human approval by policy."} />
      </div>

      {item.input && Object.keys(item.input).length ? (
        <details open className="mt-4 rounded-md border border-line bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {reconciliationRequired ? "Bound inputs" : "Exact inputs"} (secrets redacted)
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted">{JSON.stringify(item.input, null, 2)}</pre>
        </details>
      ) : null}

      {!reconciliationRequired && breakGlassAvailable ? (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 p-3">
          <label className="flex items-start gap-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={breakGlass}
              onChange={(event) => onBreakGlass(event.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              Use emergency break-glass approval
              <span className="mt-1 block text-xs font-normal leading-5 text-muted">
                {String(
                  breakGlassPolicy.description ||
                    "Bypass normal quorum under the configured emergency policy.",
                )}
              </span>
            </span>
          </label>
          {breakGlass && ticketRequired ? (
            <input
              value={ticket}
              onChange={(event) => onTicket(event.target.value)}
              placeholder="Required incident or change ticket"
              aria-label="Break-glass ticket reference"
              className="mt-3 min-h-11 w-full rounded-md border border-line bg-background px-3 text-sm placeholder:text-muted"
            />
          ) : null}
        </div>
      ) : null}

      {reconciliationRequired ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="max-w-3xl text-sm leading-5 text-muted">
            Approval is already recorded. This verifies the immutable deletion
            receipt first and replays only the same bound request if needed.
          </p>
          <button
            type="button"
            onClick={() => onDecide("approve")}
            disabled={Boolean(inFlight)}
            className="primary-button"
          >
            {inFlight === "approve" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Reconcile and continue
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={reason}
              onChange={(event) => onReason(event.target.value)}
              placeholder={
                breakGlass
                  ? `Required emergency rationale (${reasonMinimum}+ characters)`
                  : attestationRequired
                    ? "Required approval attestation (12+ characters)"
                    : "Optional decision note (recorded in the audit trail)"
              }
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-background px-3 text-sm placeholder:text-muted"
              aria-label={
                breakGlass
                  ? "Required break-glass rationale"
                  : attestationRequired
                    ? "Required approval attestation"
                    : "Decision reason"
              }
            />
            <button type="button" onClick={() => onDecide("reject")} disabled={Boolean(inFlight)} className="action-button">
              {inFlight === "reject" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
              Reject
            </button>
            <button
              type="button"
              onClick={() => onDecide("approve")}
              disabled={
                Boolean(inFlight) ||
                Boolean(approvalBlockedReason) ||
                Boolean(approvalFormBlockedReason)
              }
              title={approvalBlockedReason || approvalFormBlockedReason}
              className="primary-button"
            >
              {inFlight === "approve" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
              {breakGlass
                ? "Emergency approve"
                : progress && progress.have + 1 < progress.need
                ? `Record approval ${Math.min(progress.have + 1, progress.need)} of ${progress.need}`
                : "Approve and run"}
            </button>
          </div>
          {approvalBlockedReason || approvalFormBlockedReason ? (
            <p className="mt-2 text-xs leading-5 text-muted">
              {approvalBlockedReason || approvalFormBlockedReason}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}

function approvalProgress(item: ApprovalItem) {
  if (isReconciliationItem(item)) {
    return undefined;
  }
  if (item.kind === "tool" && item.riskLevel >= 3) {
    const approvers = new Set(
      (item.record?.approvals || [])
        .filter((approval) => approval.role === "admin" || approval.role === "system")
        .map((approval) => approval.by || approval.actorId)
        .filter(Boolean),
    );
    return { have: approvers.size, need: 2 };
  }
  if (item.kind === "slo_policy") {
    const raw = item.input?.approvalProgress;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as JsonRecord;
      const have = Number(record.approvals || 0);
      const need = Number(record.required || 1);
      if (need > 1) {
        return { have, need };
      }
    }
  }
  return undefined;
}

function blockedApprovalReason(
  item: ApprovalItem,
  approverRole: string,
  approverId?: string,
  options: {
    breakGlass?: boolean;
    breakGlassPolicy?: JsonRecord;
  } = {},
) {
  if (isReconciliationItem(item)) {
    return undefined;
  }
  if (
    approverId &&
    item.record?.approvals?.some(
      (approval) => (approval.by || approval.actorId) === approverId,
    )
  ) {
    return "Your approval is already recorded. Another eligible approver must review this item.";
  }
  if (item.kind === "tool" && item.riskLevel >= 3) {
    if (!["admin", "system"].includes(approverRole)) {
      return "Risk 3 tool calls require an admin approval.";
    }
    if (approverId && item.requestedBy === approverId) {
      return "The requester cannot approve their own risk 3 tool call.";
    }
  }
  if (item.kind === "slo_policy") {
    const rawPolicy = item.input?.approvalPolicy;
    if (rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)) {
      const policy = rawPolicy as JsonRecord;
      if (options.breakGlass) {
        const requiredRole = String(
          options.breakGlassPolicy?.requiredRole || "admin",
        );
        if (roleRank(approverRole) < roleRank(requiredRole)) {
          return `Emergency approval requires ${requiredRole} role or higher.`;
        }
      } else {
        const requiredRoles = Array.isArray(policy.requiredRoles)
          ? policy.requiredRoles.map(String)
          : [];
        if (requiredRoles.length && !requiredRoles.includes(approverRole)) {
          return `This policy change requires one of these roles: ${requiredRoles.join(", ")}.`;
        }
      }
      if (
        policy.allowRequesterApproval === false &&
        approverId &&
        item.requestedBy === approverId
      ) {
        return "The requester cannot approve their own SLO policy change.";
      }
    }
  }
  return undefined;
}

function TrackRecord({
  trust,
  threshold,
  enabled,
}: {
  trust: TrustProfile;
  threshold?: number;
  enabled?: boolean;
}) {
  const target = threshold || 25;
  const graduated = trust.autonomyMode === "auto_with_alert";
  const pct = Math.min(Math.round((trust.autonomy?.progress ?? trust.cleanStreak / target) * 100), 100);
  const stage = trust.autonomy?.stage || (graduated ? "autonomous" : "shadow");
  return (
    <div className="mt-4 rounded-md border border-line bg-background p-3" data-daybook="track">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{stage} evidence gate</p>
        <p className="text-xs text-muted">
          {trust.successes} ok · {trust.failures} failed · streak {trust.cleanStreak}
        </p>
      </div>
      {trust.reversible ? (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
            <div className={clsx("h-full rounded-full", graduated ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            {trust.autonomy?.reason || (graduated
              ? enabled
                ? "Evidence threshold reached. Execution still requires an exact bounded plan grant."
                : "Evidence threshold reached; approval remains required."
              : `${trust.cleanStreak}/${target} clean executions toward earning autonomy.`)}
          </p>
          {trust.autonomy ? (
            <p className="mt-1 text-[11px] text-muted">
              Reliability {Math.round(trust.autonomy.score * 100)}% · confidence {Math.round(trust.autonomy.confidence * 100)}% · budget {trust.autonomy.budget.maxActions}/hour
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">Irreversible action. It is always gated and never graduates.</p>
      )}
    </div>
  );
}

function ConsentFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-background p-3" data-daybook="fact">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 text-sm leading-5">{value}</p>
    </div>
  );
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function roleRank(role: string) {
  return {
    viewer: 0,
    operator: 1,
    admin: 2,
    system: 3,
  }[role] ?? -1;
}

export function decisionNoticeClasses(tone: DecisionNotice["tone"]) {
  if (tone === "danger") {
    return "border-danger/40 bg-danger/10 text-danger";
  }
  if (tone === "warning") {
    return "border-warning/45 bg-warning/10";
  }
  if (tone === "success") {
    return "border-success/40 bg-success/10";
  }
  return "border-line bg-surface";
}

export function kindLabel(kind: ApprovalItem["kind"]) {
  if (kind === "tool") {
    return "tool call";
  }
  return kind === "workflow" ? "workflow gate" : "SLO policy";
}

function whatWillHappen(item: ApprovalItem) {
  if (isReconciliationItem(item)) {
    return "The system checks the immutable deletion receipt first. If deletion already committed, it finalizes the existing audit record; otherwise it safely replays only the same tenant-, actor-, input-, and approval-bound request.";
  }
  if (item.kind === "tool") {
    const effect = item.contract?.effect ? `${item.contract.effect} ` : "";
    return `${effect}The ${item.title} tool executes for real with the inputs below, and the output is recorded in the tool audit ledger.`;
  }
  if (item.kind === "workflow") {
    return "The workflow resumes. Exact reviewed reversible actions receive short-lived, budgeted plan grants; dynamic or changed targets still pause for their own approval.";
  }
  return "The monitoring policy change is applied and starts affecting SLO evaluation, incidents, and alerts.";
}

/**
 * A tool's reversibility is what its contract declares, whatever its risk.
 * A tool without one is treated as permanent.
 */
function reversibility(item: ApprovalItem) {
  if (item.kind === "tool") {
    if (item.contract?.readOnly) {
      return "Read-only. It reads data and changes nothing.";
    }
    return item.contract?.reversible
      ? "Reversible. Its tool contract declares an effect that can be undone afterwards."
      : "Not reversible. Its tool contract does not declare an effect that can be undone, so treat it as permanent.";
  }
  const { riskLevel } = item;
  if (riskLevel <= 1) {
    return "Low impact. It writes to internal stores that can be edited or removed afterwards.";
  }
  if (riskLevel === 2) {
    return "Side-effecting. It may reach external systems and may not be reversible. Review the inputs first.";
  }
  return "High impact. It requires two distinct admin approvals, and the requester cannot approve their own request.";
}

function riskPill(riskLevel: number) {
  if (riskLevel <= 1) {
    return "bg-success/10 text-success";
  }
  return riskLevel === 2 ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger";
}

export function formatTime(value: string) {
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
