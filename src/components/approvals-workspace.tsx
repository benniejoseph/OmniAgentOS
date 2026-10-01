"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import {
  ApprovalCard,
  DecisionNoticeRegion,
  formatTime,
} from "@/components/approvals/approval-card";
import {
  APPROVAL_PAGE_SIZE,
  MAX_REFRESHED_APPROVALS,
  announceInboxChanged,
  approvalHeadingId,
  approvalItemKey,
  approvalReturnPath,
  findFocusedApproval,
  focusAfterDecision,
  loadApprovalQueue,
  matchesApprovalFocus,
  submitApprovalDecision,
  type ApprovalDecision,
  type ApprovalItem,
  type ApprovalQueuePage,
  type DecisionNotice,
  type FocusedApproval,
  type JsonRecord,
  type TrustResponse,
} from "@/components/approvals/approval-decision";
import { useLiveRefresh } from "@/components/use-live-refresh";
import {
  approvalReturnLabel,
  commandConversationHref,
  type ApprovalKind,
} from "@/lib/approvals/inbox-link";
import { ASAEL_PENDING_USER_PROVISION_KEY } from "@/lib/browser-storage-keys";
import styles from "./daybook-workspaces.module.css";

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

type FocusState =
  | FocusedApproval
  | { status: "error"; message: string };

type DecisionList = "actions" | "access";

const ACTION_LIST_HEADING_ID = "action-approval-heading";
const ACCESS_LIST_HEADING_ID = "access-request-heading";

function accessRequestKey(item: Pick<AccessRequestItem, "id">) {
  return `access:${item.id}`;
}

export function ApprovalsWorkspace({
  focusId,
  focusKind,
  returnTo,
}: {
  /** The item a link opened the inbox on. */
  focusId?: string;
  focusKind?: ApprovalKind;
  /** Where to send the approver once that item is decided. */
  returnTo?: string;
}) {
  const router = useRouter();
  const {
    session,
    status: sessionStatus,
    role,
  } = useWorkspaceSession();
  const [queue, setQueue] = useState<ApprovalQueuePage>();
  const [focused, setFocused] = useState<FocusState>();
  const [focusDecided, setFocusDecided] = useState(false);
  const [shownLimit, setShownLimit] = useState(APPROVAL_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [decisionInFlight, setDecisionInFlight] = useState<{ key: string; decision: string }>();
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
  const shownLimitRef = useRef(APPROVAL_PAGE_SIZE);
  // The card a decision was made on, until the queues are read back.
  const decidedRef = useRef<{ list: DecisionList; key: string }>(undefined);
  // The cards each list showed before its latest read.
  const shownKeysRef = useRef<Record<DecisionList, readonly string[]>>({
    actions: [],
    access: [],
  });
  const decisionPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const accessPermission = permissionMessage(session, sessionStatus, "manage.identity");
  const focus = useMemo(
    () => (focusId ? { id: focusId, kind: focusKind } : undefined),
    [focusId, focusKind],
  );

  /** Reads the queues again, and says whether what it read is shown. */
  async function load() {
    const loadVersion = ++loadVersionRef.current;
    if (decisionPermission && accessPermission) {
      setState("ready");
      return false;
    }
    setState("loading");
    setError(undefined);
    try {
      const [queuePage, trustRes, accessRes] = await Promise.all([
        decisionPermission
          ? Promise.resolve(undefined)
          : loadApprovalQueue(shownLimitRef.current),
        decisionPermission
          ? Promise.resolve(undefined)
          : fetch("/api/trust").catch(() => undefined),
        accessPermission
          ? Promise.resolve(undefined)
          : fetch("/api/onboarding/access-requests?status=actionable&limit=50"),
      ]);
      // The queue shown has its own error; the linked item reports its own.
      const focusedApproval: FocusState | undefined = queuePage && focus
        ? await findFocusedApproval(queuePage, focus).catch((focusError: unknown) => ({
            status: "error" as const,
            message: focusError instanceof Error
              ? focusError.message
              : "The approval you opened could not be loaded.",
          }))
        : undefined;
      const trustBody = trustRes && trustRes.ok
        ? ((await trustRes.json().catch(() => undefined)) as TrustResponse | undefined)
        : undefined;
      let accessBody: AccessQueueResponse | undefined;
      let accessError: Error | undefined;
      if (accessRes) {
        const body = (await accessRes.json().catch(() => ({}))) as JsonRecord;
        if (accessRes.ok) {
          accessBody = body as unknown as AccessQueueResponse;
        } else {
          accessError = new Error(String(body.message || body.error || `Access requests returned ${accessRes.status}`));
        }
      }
      if (loadVersion !== loadVersionRef.current) {
        return false;
      }
      if (queuePage) {
        setQueue(queuePage);
      }
      if (focusedApproval) {
        setFocused(focusedApproval);
      }
      if (trustBody) {
        setTrust(trustBody);
      }
      if (accessError) {
        throw accessError;
      }
      if (accessBody) {
        setAccessQueue(accessBody);
      }
      setState("ready");
      return true;
    } catch (loadError) {
      if (loadVersion !== loadVersionRef.current) {
        return false;
      }
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Approvals unavailable.");
      return false;
    }
  }

  /** Reads the queues back after a decision on the card with this key. */
  async function rereadAfterDecision(list: DecisionList, key: string) {
    decidedRef.current = { list, key };
    if (!(await load())) {
      decidedRef.current = undefined;
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
    onRefresh: async () => {
      await load();
    },
    pollIntervalMs: 10_000,
  });

  function showMore() {
    const next = Math.min(
      MAX_REFRESHED_APPROVALS,
      shownLimitRef.current + APPROVAL_PAGE_SIZE,
    );
    shownLimitRef.current = next;
    setShownLimit(next);
    setLoadingMore(true);
    void load().finally(() => setLoadingMore(false));
  }

  async function decide(item: ApprovalItem, decision: ApprovalDecision) {
    if (decisionPermission) {
      setError(decisionPermission);
      return;
    }
    const key = approvalItemKey(item);
    const decidingFocus = Boolean(focus && matchesApprovalFocus(item, focus));
    setDecisionInFlight({ key, decision });
    setError(undefined);
    setLastDecision(undefined);
    try {
      const notice = await submitApprovalDecision(item, decision, {
        reason: reasons[key],
        breakGlass: breakGlassSelections[key],
        ticket: tickets[key],
      });
      setApprovedAccessRequest(undefined);
      setLastDecision(notice);
      announceInboxChanged();
      if (decidingFocus) {
        setFocusDecided(true);
      }
      const back = approvalReturnPath(item, notice, focus, returnTo);
      if (back) {
        router.push(back);
        return;
      }
      await rereadAfterDecision("actions", key);
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
    const key = accessRequestKey(item);
    setDecisionInFlight({ key, decision });
    setError(undefined);
    setLastDecision(undefined);
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
      announceInboxChanged();
      await rereadAfterDecision("access", key);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      setDecisionInFlight(undefined);
    }
  }

  function beginProvisioning(item: AccessRequestItem) {
    try {
      window.sessionStorage.setItem(
        ASAEL_PENDING_USER_PROVISION_KEY,
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

  const focusedItem = focused?.status === "ready" ? focused.item : undefined;
  const focusedKey = focusedItem ? approvalItemKey(focusedItem) : undefined;
  const items = useMemo(
    () => (queue?.items || []).filter((item) => approvalItemKey(item) !== focusedKey),
    [focusedKey, queue],
  );
  const accessRequests = useMemo(
    () => accessQueue?.requests || [],
    [accessQueue],
  );
  // The cards of each list, in the order they are shown.
  const actionKeys = useMemo(
    () => [...(focusedKey ? [focusedKey] : []), ...items.map(approvalItemKey)],
    [focusedKey, items],
  );
  const accessKeys = useMemo(
    () => accessRequests.map(accessRequestKey),
    [accessRequests],
  );

  // Once a decision is read back, focus goes to the card that took the
  // decided one's place, unless the approver took it somewhere else.
  useEffect(() => {
    const before = shownKeysRef.current;
    shownKeysRef.current = { actions: actionKeys, access: accessKeys };
    const decided = decidedRef.current;
    if (!decided) {
      return;
    }
    decidedRef.current = undefined;
    const index = before[decided.list].indexOf(decided.key);
    if (decided.list === "access") {
      focusAfterDecision(document, { key: decided.key, index }, accessKeys, ACCESS_LIST_HEADING_ID);
    } else {
      focusAfterDecision(document, { key: decided.key, index }, actionKeys, ACTION_LIST_HEADING_ID);
    }
  }, [accessKeys, actionKeys]);
  const firstLoad = state === "loading" && !queue && !accessQueue;
  const visiblePendingCount =
    (queue?.stats.total || 0) +
    (accessQueue?.stats.pending || 0) +
    (accessQueue?.stats.provisioning || 0);
  const pendingToolApprovals = queue
    ? Math.max(0, queue.stats.tools - (queue.stats.reconciliations || 0))
    : 0;
  const pendingBreakdown = [
    queue
      ? `${pendingToolApprovals} tool ${pendingToolApprovals === 1 ? "approval" : "approvals"}`
      : undefined,
    queue?.stats.reconciliations
      ? `${queue.stats.reconciliations} deletion ${queue.stats.reconciliations === 1 ? "reconciliation" : "reconciliations"}`
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

  function approvalCard(item: ApprovalItem, focusedCard = false) {
    const key = approvalItemKey(item);
    return (
      <ApprovalCard
        key={key}
        item={item}
        focused={focusedCard}
        originHref={
          item.origin
            ? commandConversationHref({
                threadId: item.origin.threadId,
                runId: item.origin.runId,
              })
            : undefined
        }
        trust={trust?.profiles.find((profile) => profile.toolId === item.record?.toolId)}
        trustEnabled={trust?.enabled}
        threshold={trust?.threshold}
        approverRole={role}
        approverId={session?.context?.actorId}
        reason={reasons[key] || ""}
        onReason={(value) => setReasons((current) => ({ ...current, [key]: value }))}
        breakGlass={Boolean(breakGlassSelections[key])}
        onBreakGlass={(value) =>
          setBreakGlassSelections((current) => ({
            ...current,
            [key]: value,
          }))
        }
        ticket={tickets[key] || ""}
        onTicket={(value) =>
          setTickets((current) => ({ ...current, [key]: value }))
        }
        onDecide={(decision) => void decide(item, decision)}
        inFlight={decisionInFlight?.key === key ? decisionInFlight.decision : undefined}
      />
    );
  }

  return (
    <div className={clsx("mx-auto max-w-[100rem] px-4 py-6 sm:px-6 lg:px-8", styles.daybook, styles.approvals)} aria-busy={firstLoad} data-testid="inbox-workspace">
      <section className="rounded-lg border border-line bg-surface p-5" data-daybook="hero">
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
          <div className="flex flex-wrap items-center gap-2">
            {returnTo ? (
              <Link href={returnTo} className="action-link">
                <ArrowLeft size={15} aria-hidden="true" />
                {approvalReturnLabel(returnTo)}
              </Link>
            ) : null}
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

      <DecisionNoticeRegion
        notice={lastDecision}
        className="mt-4 flex flex-col gap-3 rounded-md border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        {approvedAccessRequest ? (
          <button
            type="button"
            onClick={() => beginProvisioning(approvedAccessRequest)}
            className="action-button shrink-0"
          >
            Provision {approvedAccessRequest.name}
          </button>
        ) : null}
      </DecisionNoticeRegion>
      {error ? (
        <p className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {firstLoad ? (
        <div className="mt-4 rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
          Loading decisions…
        </div>
      ) : null}

      {focus && !decisionPermission && !(focusDecided && focused?.status === "missing") ? (
        <section className="mt-6 space-y-4" aria-labelledby="focused-approval-heading" data-daybook="section">
          <div>
            <h2 id="focused-approval-heading" className="text-base font-semibold">The approval you opened</h2>
            <p className="text-sm text-muted">
              {returnTo
                ? "Decide it here. Once the decision goes through, you go back to where you came from."
                : "Decide it here. The rest of the queue follows."}
            </p>
          </div>
          {!focused ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              Loading the approval you opened…
            </div>
          ) : focused.status === "error" ? (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger" role="alert">
              {focused.message}
            </p>
          ) : focused.status === "missing" ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted" data-focused="missing">
              <p>
                This approval is no longer waiting. It was decided, withdrawn,
                or expired.
              </p>
              {returnTo ? (
                <Link href={returnTo} className="action-link">
                  <ArrowLeft size={15} aria-hidden="true" />
                  {approvalReturnLabel(returnTo)}
                </Link>
              ) : null}
            </div>
          ) : (
            approvalCard(focused.item, true)
          )}
        </section>
      ) : null}

      {!accessPermission ? (
        <section className="mt-6 space-y-4" aria-labelledby={ACCESS_LIST_HEADING_ID} data-daybook="section">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md border border-line bg-surface">
              <UserPlus size={16} aria-hidden="true" />
            </span>
            <div>
              <h2 id={ACCESS_LIST_HEADING_ID} tabIndex={-1} className="text-base font-semibold">Workspace access</h2>
              <p className="text-sm text-muted">Review who is asking to join this tenant.</p>
            </div>
          </div>
          {state === "ready" && !accessRequests.length ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              No pending access requests.
            </div>
          ) : null}
          {accessRequests.map((item) => {
            const key = accessRequestKey(item);
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
                inFlight={decisionInFlight?.key === key ? decisionInFlight.decision : undefined}
              />
            );
          })}
        </section>
      ) : null}

      {!decisionPermission ? (
        <section className="mt-6 space-y-4" aria-labelledby={ACTION_LIST_HEADING_ID} data-daybook="section">
          <div>
            <h2 id={ACTION_LIST_HEADING_ID} tabIndex={-1} className="text-base font-semibold">Agent and workflow actions</h2>
            <p className="text-sm text-muted">Review new approvals and safely reconcile previously approved actions with unresolved outcomes. The riskiest and longest-waiting come first.</p>
          </div>
          {state === "ready" && !items.length ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              {focusedItem ? "Nothing else is waiting." : "No pending action approvals."}
            </div>
          ) : null}
          {items.map((item) => approvalCard(item))}
          {queue?.nextCursor ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              <p className="text-xs text-muted">
                Showing {queue.items.length} of {queue.stats.total}.
              </p>
              {shownLimit < MAX_REFRESHED_APPROVALS ? (
                <button
                  type="button"
                  onClick={showMore}
                  disabled={loadingMore}
                  className="action-button"
                >
                  {loadingMore ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                  Show more
                </button>
              ) : (
                <p className="text-xs text-muted">Decide some of these to see the rest.</p>
              )}
            </div>
          ) : null}
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
    <article className="rounded-lg border border-line bg-surface p-5" data-daybook="approval-item">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={approvalHeadingId(accessRequestKey(item))} tabIndex={-1} className="text-base font-semibold">{item.name}</h3>
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
