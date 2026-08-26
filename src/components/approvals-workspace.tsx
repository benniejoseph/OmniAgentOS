"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, ShieldCheck, UserPlus, X } from "lucide-react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import { useLiveRefresh } from "@/components/use-live-refresh";

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
  record?: {
    toolId?: string;
    approvals?: Array<{ by?: string; actorId?: string; role?: string }>;
    approvalPolicy?: { quorum?: number };
  };
};

type QueueResponse = {
  items: ApprovalItem[];
  stats: { total: number; tools: number; workflows: number; sloPolicies: number };
};

type TrustProfile = {
  toolId: string;
  cleanStreak: number;
  successes: number;
  failures: number;
  autonomyMode: "approve_each" | "auto_with_alert";
  reversible: boolean;
  autonomy?: {
    stage: "manual" | "shadow" | "supervised" | "autonomous";
    progress: number;
    score: number;
    confidence: number;
    freshness: number;
    reason: string;
    budget: { maxActions: number; windowSeconds: number };
  };
};

type TrustResponse = {
  enabled: boolean;
  threshold: number;
  profiles: TrustProfile[];
};

type AccessRequestItem = {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
  timeline: string;
  useCase: string;
  status:
    | "pending_review"
    | "approved"
    | "provisioning_pending"
    | "provisioned"
    | "declined";
  createdAt: string;
};

type AccessQueueResponse = {
  requests: AccessRequestItem[];
  stats: { shown: number; pending: number; provisioning?: number };
};

type DecisionNotice = {
  message: string;
  tone: "success" | "warning" | "danger" | "neutral";
};

export function ApprovalsWorkspace() {
  const router = useRouter();
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [queue, setQueue] = useState<QueueResponse>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [decisionInFlight, setDecisionInFlight] = useState<string>();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [breakGlassSelections, setBreakGlassSelections] = useState<
    Record<string, boolean>
  >({});
  const [tickets, setTickets] = useState<Record<string, string>>({});
  const [lastDecision, setLastDecision] = useState<DecisionNotice>();
  const [approvedAccessRequest, setApprovedAccessRequest] = useState<AccessRequestItem>();
  const [trust, setTrust] = useState<TrustResponse>();
  const [accessQueue, setAccessQueue] = useState<AccessQueueResponse>();
  const loadVersionRef = useRef(0);
  const decisionPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const accessPermission = permissionMessage(session, sessionStatus, "manage.identity");

  async function load() {
    const loadVersion = ++loadVersionRef.current;
    if (decisionPermission && accessPermission) {
      setState("ready");
      return;
    }
    setState("loading");
    setError(undefined);
    try {
      const [queueRes, trustRes, accessRes] = await Promise.all([
        decisionPermission ? Promise.resolve(undefined) : fetch("/api/approvals?limit=50"),
        decisionPermission
          ? Promise.resolve(undefined)
          : fetch("/api/trust").catch(() => undefined),
        accessPermission
          ? Promise.resolve(undefined)
          : fetch("/api/onboarding/access-requests?status=actionable&limit=50"),
      ]);
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      if (queueRes) {
        const body = (await queueRes.json().catch(() => ({}))) as JsonRecord;
        if (!queueRes.ok) {
          throw new Error(String(body.message || body.error || `Approvals returned ${queueRes.status}`));
        }
        setQueue(body as unknown as QueueResponse);
      }
      if (trustRes && trustRes.ok) {
        setTrust((await trustRes.json().catch(() => undefined)) as TrustResponse | undefined);
      }
      if (accessRes) {
        const body = (await accessRes.json().catch(() => ({}))) as JsonRecord;
        if (!accessRes.ok) {
          throw new Error(String(body.message || body.error || `Access requests returned ${accessRes.status}`));
        }
        setAccessQueue(body as unknown as AccessQueueResponse);
      }
      setState("ready");
    } catch (loadError) {
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Approvals unavailable.");
    }
  }

  useEffect(() => {
    if (sessionStatus === "loading") {
      return;
    }
    if (decisionPermission && accessPermission) {
      const timer = window.setTimeout(() => {
        setState(sessionStatus === "error" ? "error" : "ready");
        setError(sessionStatus === "error" ? "Session status is unavailable." : undefined);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // Permission changes are the only reason to re-read the queue automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessPermission, decisionPermission, sessionStatus]);

  useLiveRefresh({
    enabled:
      sessionStatus === "ready" &&
      (!decisionPermission || !accessPermission),
    onRefresh: load,
    pollIntervalMs: 10_000,
  });

  async function decide(item: ApprovalItem, decision: "approve" | "reject") {
    if (decisionPermission) {
      setError(decisionPermission);
      return;
    }
    setDecisionInFlight(`${item.id}:${decision}`);
    setError(undefined);
    try {
      const response = await fetch(`/api/approvals/${item.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: item.kind,
          decision,
          reason: reasons[item.id] || undefined,
          breakGlass:
            item.kind === "slo_policy" && decision === "approve"
              ? Boolean(breakGlassSelections[item.id])
              : undefined,
          ticket:
            item.kind === "slo_policy" && decision === "approve"
              ? tickets[item.id] || undefined
              : undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        throw new Error(String(body.message || body.error || `Decision failed (${response.status}).`));
      }
      const continuation = body.continuation as { scheduled?: boolean; rejected?: boolean } | undefined;
      const quorum = body.quorum as
        | { have?: number; need?: number; message?: string }
        | undefined;
      const approvalProgress = body.approvalProgress as
        | { approvals?: number; required?: number; remaining?: number }
        | undefined;
      const executionRecord = body.record as
        | { status?: string; reason?: string }
        | undefined;
      const resumeNote =
        decision === "approve" && continuation?.scheduled
        ? " The paused agent run is resuming in the background. Its final answer will appear in Results."
        : "";
      const stillPending =
        decision === "approve" &&
        (
          response.status === 202 ||
          Boolean(approvalProgress?.remaining)
        );
      setApprovedAccessRequest(undefined);
      setLastDecision({
        message:
        executionRecord?.status === "failed"
          ? `Approval recorded for ${item.title}, but execution failed${
              executionRecord.reason ? `: ${executionRecord.reason}` : "."
            }${resumeNote}`
          : stillPending
          ? `Approval recorded for ${item.title}. ${
              quorum?.message ||
              `${approvalProgress?.approvals || 0}/${approvalProgress?.required || 1} required approvals are recorded.`
            }`
          : `${decision === "approve" ? "Approved and released" : "Rejected"}: ${item.title}.${resumeNote}`,
        tone:
          executionRecord?.status === "failed"
            ? "danger"
            : stillPending
              ? "warning"
              : "success",
      });
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      setDecisionInFlight(undefined);
    }
  }

  async function decideAccess(
    item: AccessRequestItem,
    decision: "approved" | "declined",
  ) {
    if (accessPermission) {
      setError(accessPermission);
      return;
    }
    const key = `access:${item.id}`;
    setDecisionInFlight(`${key}:${decision}`);
    setError(undefined);
    try {
      const response = await fetch("/api/onboarding/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          decision,
          note: reasons[key] || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        throw new Error(String(body.message || body.error || `Decision failed (${response.status}).`));
      }
      setLastDecision({
        message:
          decision === "approved"
            ? `Approved ${item.name}'s access request. Create their account in Settings, then send them the sign-in details through an approved channel.`
            : `Declined ${item.name}'s access request.`,
        tone: decision === "approved" ? "success" : "neutral",
      });
      setApprovedAccessRequest(decision === "approved" ? item : undefined);
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      setDecisionInFlight(undefined);
    }
  }

  function beginProvisioning(item: AccessRequestItem) {
    try {
      window.sessionStorage.setItem(
        "omniagent:pending-user-provision",
        JSON.stringify({
          accessRequestId: item.id,
          name: item.name,
          email: item.email,
        }),
      );
    } catch {
      // Navigation remains useful when browser storage is unavailable.
    }
    router.push("/app/settings#create-user");
  }

  const items = useMemo(() => queue?.items || [], [queue]);
  const accessRequests = useMemo(
    () => accessQueue?.requests || [],
    [accessQueue],
  );
  const visiblePendingCount =
    (queue?.stats.total || 0) +
    (accessQueue?.stats.pending || 0) +
    (accessQueue?.stats.provisioning || 0);
  const pendingBreakdown = [
    queue
      ? `${queue.stats.tools} tool ${queue.stats.tools === 1 ? "call" : "calls"}`
      : undefined,
    queue
      ? `${queue.stats.workflows} ${queue.stats.workflows === 1 ? "workflow" : "workflows"}`
      : undefined,
    queue
      ? `${queue.stats.sloPolicies} policy ${queue.stats.sloPolicies === 1 ? "change" : "changes"}`
      : undefined,
    accessQueue
      ? `${(accessQueue.stats.pending || 0) + (accessQueue.stats.provisioning || 0)} access ${
          (accessQueue.stats.pending || 0) + (accessQueue.stats.provisioning || 0) === 1
            ? "request"
            : "requests"
        }`
      : undefined,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-[100rem] px-4 py-6 sm:px-6 lg:px-8" aria-busy={state === "loading"} data-testid="inbox-workspace">
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-ink">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-semibold text-primary">Approvals</p>
              <h1 className="mt-1 text-xl font-semibold">Decide what can proceed.</h1>
              <p className="mt-1 text-sm text-muted">
                Review agent actions and workspace access requests from one queue.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="action-button"
            disabled={
              state === "loading" ||
              Boolean(decisionPermission && accessPermission)
            }
            title={
              decisionPermission && accessPermission
                ? decisionPermission
                : undefined
            }
          >
            {state === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            Refresh
          </button>
        </div>
        {queue || accessQueue ? (
          <p className="mt-4 text-sm text-muted">
            {visiblePendingCount ? (
              <>
                <span className="font-semibold text-foreground">
                  {visiblePendingCount} pending
                </span>
                {`: ${pendingBreakdown.join(", ")}.`}
              </>
            ) : (
              <>
                Nothing is waiting in the queues you can access.
                {!accessQueue ? " Workspace access requests are visible to admins." : ""}
              </>
            )}
          </p>
        ) : null}
      </section>

      {decisionPermission && sessionStatus !== "loading" ? (
        <section className="mt-4 flex flex-col gap-3 rounded-md border border-warning/45 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold">Approval access is limited</h2>
              <p className="mt-1 text-sm leading-6 text-muted">{decisionPermission} Current role: {role}.</p>
            </div>
          </div>
          {session?.authEnabled && !session.authenticated ? (
            <Link href="/login" className="primary-button shrink-0">Sign in</Link>
          ) : null}
        </section>
      ) : null}

      {lastDecision ? (
        <div
          className={clsx(
            "mt-4 flex flex-col gap-3 rounded-md border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
            decisionNoticeClasses(lastDecision.tone),
          )}
          role={lastDecision.tone === "danger" ? "alert" : "status"}
        >
          <p>{lastDecision.message}</p>
          {approvedAccessRequest ? (
            <button
              type="button"
              onClick={() => beginProvisioning(approvedAccessRequest)}
              className="action-button shrink-0"
            >
              Provision {approvedAccessRequest.name}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {state === "loading" && !queue && !accessQueue ? (
        <div className="mt-4 rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
          Loading decisions…
        </div>
      ) : null}

      {!accessPermission ? (
        <section className="mt-6 space-y-4" aria-labelledby="access-request-heading">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md border border-line bg-surface">
              <UserPlus size={16} aria-hidden="true" />
            </span>
            <div>
              <h2 id="access-request-heading" className="text-base font-semibold">Workspace access</h2>
              <p className="text-sm text-muted">Review who is asking to join this tenant.</p>
            </div>
          </div>
          {state === "ready" && !accessRequests.length ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              No pending access requests.
            </div>
          ) : null}
          {accessRequests.map((item) => {
            const key = `access:${item.id}`;
            return (
              <AccessRequestCard
                key={item.id}
                item={item}
                note={reasons[key] || ""}
                onNote={(value) =>
                  setReasons((current) => ({ ...current, [key]: value }))
                }
                onDecide={(decision) => void decideAccess(item, decision)}
                onProvision={() => beginProvisioning(item)}
                inFlight={
                  decisionInFlight?.startsWith(`${key}:`)
                    ? decisionInFlight.split(":").at(-1)
                    : undefined
                }
              />
            );
          })}
        </section>
      ) : null}

      {!decisionPermission ? (
        <section className="mt-6 space-y-4" aria-labelledby="action-approval-heading">
          <div>
            <h2 id="action-approval-heading" className="text-base font-semibold">Agent and workflow actions</h2>
            <p className="text-sm text-muted">Nothing executes until an authorized operator approves it.</p>
          </div>
          {state === "ready" && !items.length ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              No pending action approvals.
            </div>
          ) : null}
          {items.map((item) => (
            <ApprovalCard
              key={`${item.kind}-${item.id}`}
              item={item}
              trust={trust?.profiles.find((profile) => profile.toolId === item.record?.toolId)}
              trustEnabled={trust?.enabled}
              threshold={trust?.threshold}
              approverRole={role}
              approverId={session?.context?.actorId}
              reason={reasons[item.id] || ""}
              onReason={(value) => setReasons((current) => ({ ...current, [item.id]: value }))}
              breakGlass={Boolean(breakGlassSelections[item.id])}
              onBreakGlass={(value) =>
                setBreakGlassSelections((current) => ({
                  ...current,
                  [item.id]: value,
                }))
              }
              ticket={tickets[item.id] || ""}
              onTicket={(value) =>
                setTickets((current) => ({ ...current, [item.id]: value }))
              }
              onDecide={(decision) => void decide(item, decision)}
              inFlight={
                decisionInFlight?.startsWith(`${item.id}:`)
                  ? decisionInFlight.split(":").at(-1)
                  : undefined
              }
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function AccessRequestCard({
  item,
  note,
  onNote,
  onDecide,
  onProvision,
  inFlight,
}: {
  item: AccessRequestItem;
  note: string;
  onNote: (value: string) => void;
  onDecide: (decision: "approved" | "declined") => void;
  onProvision: () => void;
  inFlight?: string;
}) {
  const needsProvisioning =
    item.status === "approved" || item.status === "provisioning_pending";
  return (
    <article className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{item.name}</h3>
          <p className="mt-1 text-sm text-muted">
            {item.email} · {item.company}
          </p>
          <p className="mt-1 text-xs text-muted">
            Requested {formatTime(item.createdAt)} · {accessRoleLabel(item.role)} · {timelineLabel(item.timeline)}
          </p>
        </div>
        <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-medium text-warning">
          {needsProvisioning ? "provisioning needed" : "access request"}
        </span>
      </div>
      <div className="mt-4 rounded-md border border-line bg-background p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">What they want to do</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{item.useCase}</p>
      </div>
      {needsProvisioning ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm">
            Access is approved. Finish creating the workspace identity; this
            request stays here until provisioning succeeds.
          </p>
          <button
            type="button"
            onClick={onProvision}
            className="primary-button shrink-0"
          >
            <UserPlus size={14} aria-hidden="true" />
            Resume provisioning
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-xs leading-5 text-muted">
            Approving records the decision and keeps this request in Approvals
            until the workspace identity is provisioned.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={note}
              onChange={(event) => onNote(event.target.value)}
              placeholder="Optional review note"
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-background px-3 text-sm placeholder:text-muted"
              aria-label={`Review note for ${item.name}`}
            />
            <button
              type="button"
              onClick={() => onDecide("declined")}
              disabled={Boolean(inFlight)}
              className="action-button"
            >
              {inFlight === "declined" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
              Decline
            </button>
            <button
              type="button"
              onClick={() => onDecide("approved")}
              disabled={Boolean(inFlight)}
              className="primary-button"
            >
              {inFlight === "approved" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
              Approve request
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function ApprovalCard({
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
}) {
  const progress = approvalProgress(item);
  const approvalPolicy = recordValue(item.input?.approvalPolicy);
  const breakGlassPolicy = recordValue(item.input?.breakGlassPolicy);
  const attestationRequired =
    item.kind === "slo_policy" &&
    Boolean(approvalPolicy.attestationRequired);
  const breakGlassAvailable =
    item.kind === "slo_policy" &&
    Boolean(approvalPolicy.breakGlassAllowed) &&
    Boolean(breakGlassPolicy.enabled);
  const approvalBlockedReason = blockedApprovalReason(
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

      {trust ? <TrackRecord trust={trust} threshold={threshold} enabled={trustEnabled} /> : null}
      {progress ? (
        <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {progress.have}/{progress.need} distinct approvals recorded. This
          action runs only after quorum is reached.
        </p>
      ) : null}

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

      {breakGlassAvailable ? (
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
    </article>
  );
}

function approvalProgress(item: ApprovalItem) {
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
    <div className="mt-4 rounded-md border border-line bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{stage} learning</p>
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
                ? "Earned autonomy. Future calls run automatically with alerting."
                : "Eligible for autonomy. Enable graduated autonomy to let it run without gating."
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
    <div className="rounded-md border border-line bg-background p-3">
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

function decisionNoticeClasses(tone: DecisionNotice["tone"]) {
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

function accessRoleLabel(value: string) {
  return {
    founder: "Founder",
    engineering: "Engineering",
    product: "Product",
    operations: "Operations",
    security: "Security",
    other: "Other role",
  }[value] || value;
}

function timelineLabel(value: string) {
  return {
    now: "Needs access now",
    "30_days": "Planning within 30 days",
    quarter: "Planning this quarter",
    research: "Researching",
  }[value] || value;
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
