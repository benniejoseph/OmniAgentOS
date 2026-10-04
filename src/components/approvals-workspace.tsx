"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import { CommandWorkspaceScope } from "@/components/command/command-workspace-scope";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
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
  ApprovalDecisionUnconfirmedError,
  MAX_REFRESHED_APPROVALS,
  announceInboxChanged,
  approvalHeadingId,
  approvalItemKey,
  approvalReturnPath,
  findFocusedApproval,
  fetchApprovalQueuePage,
  fetchApprovalQueueItem,
  focusAfterDecision,
  loadApprovalQueue,
  matchesApprovalFocus,
  submitApprovalDecision,
  type ApprovalDecision,
  type ApprovalDecisionRequest,
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
import styles from "./approvals/approvals.module.css";

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

/** Synchronous event admission; rendering uses decisionInFlight state. */
class ApprovalDecisionGate {
  #busy = false;
  enter() {
    if (this.#busy) return false;
    this.#busy = true;
    return true;
  }
  leave() { this.#busy = false; }
}

function DecisionApprovalCard({ onDecision, ...props }: Omit<ComponentProps<typeof ApprovalCard>, "onDecide"> & {
  onDecision: (item: ApprovalItem, decision: ApprovalDecision) => Promise<void>;
}) {
  return <ApprovalCard {...props} onDecide={(decision) => void onDecision(props.item, decision)} />;
}

function accessRequestKey(item: Pick<AccessRequestItem, "id">) {
  return `access:${item.id}`;
}

type ApprovalsWorkspaceProps = {
  /** The item a link opened the inbox on. */
  focusId?: string;
  focusKind?: ApprovalKind;
  /** Where to send the approver once that item is decided. */
  returnTo?: string;
};

export function ApprovalsWorkspace(props: ApprovalsWorkspaceProps) {
  const { session, role, status } = useWorkspaceSession();
  const owner = workspaceOwnerScope(session, role);
  return <OwnedApprovalsWorkspace key={owner || "unconfirmed"} {...props} ownerScope={owner} scopeAvailable={Boolean(owner) && status === "ready"} />;
}

function OwnedApprovalsWorkspace({ focusId, focusKind, returnTo, ownerScope, scopeAvailable }: ApprovalsWorkspaceProps & { ownerScope: string; scopeAvailable: boolean }) {
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
  const [scope] = useState(() => new CommandWorkspaceScope(scopeAvailable));
  const fetch = useCallback<typeof globalThis.fetch>((input, init) => scope.run((signal) => globalThis.fetch(input, { ...init, signal }), init?.signal), [scope]);
  const [decisionGate] = useState(() => new ApprovalDecisionGate());
  const [decisionRecovery, setDecisionRecovery] = useState<{ item: ApprovalItem; request: Readonly<ApprovalDecisionRequest> }>();
  useLayoutEffect(() => {
    scope.setAvailable(scopeAvailable);
    return () => { scope.setAvailable(false); loadVersionRef.current += 1; };
  }, [scope, scopeAvailable]);
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
    if (!scope.current()) return false;
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
          : loadApprovalQueue(shownLimitRef.current, (request) => fetchApprovalQueuePage(request, fetch)),
        decisionPermission
          ? Promise.resolve(undefined)
          : fetch("/api/trust").catch(() => undefined),
        accessPermission
          ? Promise.resolve(undefined)
          : fetch("/api/onboarding/access-requests?status=actionable&limit=50"),
      ]);
      // The queue shown has its own error; the linked item reports its own.
      const focusedApproval: FocusState | undefined = queuePage && focus
        ? await findFocusedApproval(queuePage, focus, (requested) => fetchApprovalQueueItem(requested, fetch)).catch((focusError: unknown) => ({
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

  async function decide(item: ApprovalItem, decision: ApprovalDecision, frozen?: Readonly<ApprovalDecisionRequest>) {
    if (!scope.current() || (decisionRecovery && !frozen)) return;
    if (decisionPermission) {
      setError(decisionPermission);
      return;
    }
    const key = approvalItemKey(item);
    if (!decisionGate.enter()) return;
    const lease = scope.capture();
    const decidingFocus = Boolean(focus && matchesApprovalFocus(item, focus));
    setDecisionInFlight({ key, decision });
    setError(undefined);
    setLastDecision(undefined);
    try {
      const notice = await submitApprovalDecision(item, decision, frozen ?? {
        reason: reasons[key],
        breakGlass: breakGlassSelections[key],
        ticket: tickets[key],
      }, fetch, { scope: ownerScope, isCurrent: lease.current });
      if (!lease.current()) return;
      setDecisionRecovery(undefined);
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
      if (!lease.current()) return;
      if (decisionError instanceof ApprovalDecisionUnconfirmedError) setDecisionRecovery({ item, request: decisionError.request });
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      decisionGate.leave();
      setDecisionInFlight(undefined);
    }
  }

  async function decideAccess(
    item: AccessRequestItem,
    decision: "approved" | "declined",
  ) {
    if (!scope.current() || decisionRecovery) return;
    if (accessPermission) {
      setError(accessPermission);
      return;
    }
    const key = accessRequestKey(item);
    if (!decisionGate.enter()) return;
    const lease = scope.capture();
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
      if (!lease.current()) return;
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
      if (!lease.current()) return;
      setError(decisionError instanceof Error ? decisionError.message : "Decision failed.");
    } finally {
      decisionGate.leave();
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
      <DecisionApprovalCard
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
        onDecision={decide}
        inFlight={decisionInFlight?.key === key ? decisionInFlight.decision : decisionRecovery?.request.decision}
      />
    );
  }

  if (!scopeAvailable) return <p role="status">Confirming account access. Private approvals are hidden.</p>;
  return (
    <div className={styles.workspace} aria-busy={firstLoad} data-testid="inbox-workspace">
      <header className={styles.pageHeader}>
        <div className={styles.headerRow}>
          <div className={styles.pageIdentity}>
            <h1>Inbox</h1>
            <p>Review agent actions and workspace access requests.</p>
          </div>
          <div className={styles.headerActions}>
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
              aria-describedby={
                decisionPermission && accessPermission && sessionStatus !== "loading"
                  ? "approval-access-limited"
                  : undefined
              }
            >
              {state === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              Refresh
            </button>
          </div>
        </div>
        {queue || accessQueue ? (
          <p className={styles.queueSummary}>
            {state === "error" ? "Last loaded queue: " : ""}
            {visiblePendingCount ? (
              <>
                <strong>
                  {visiblePendingCount} pending
                </strong>
                {`: ${pendingBreakdown.join(", ")}.`}
              </>
            ) : (
              <>
                {state === "error"
                  ? "No pending items in the last loaded queue. Refresh to check for updates."
                  : "Nothing is waiting in the queues you can access."}
                {!accessQueue && accessPermission ? " Workspace access requests are visible to admins." : ""}
              </>
            )}
          </p>
        ) : null}
      </header>

      {decisionPermission && sessionStatus !== "loading" ? (
        <section className={clsx(styles.permissionNotice, styles.warning)}>
          <div className={styles.permissionCopy}>
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2>Approval access is limited</h2>
              <p id="approval-access-limited">{decisionPermission} Current role: {role}.</p>
            </div>
          </div>
          {session?.authEnabled && !session.authenticated ? (
            <Link href="/login" className="primary-button">Sign in</Link>
          ) : null}
        </section>
      ) : null}

      {decisionRecovery ? <button type="button" disabled={Boolean(decisionInFlight)} className="action-button" onClick={() => void decide(decisionRecovery.item, decisionRecovery.request.decision, decisionRecovery.request)}>Retry same saved decision</button> : null}
      <DecisionNoticeRegion
        notice={lastDecision}
        className={styles.notice}
      >
        {approvedAccessRequest ? (
          <button
            type="button"
            onClick={() => beginProvisioning(approvedAccessRequest)}
            className="action-button"
          >
            Provision {approvedAccessRequest.name}
          </button>
        ) : null}
      </DecisionNoticeRegion>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {firstLoad ? (
        <div className={styles.loadingState}>
          <p role="status">Loading decisions…</p>
          <div className={styles.loadingGeometry} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : null}

      {focus && !decisionPermission && !(focusDecided && focused?.status === "missing") ? (
        <section className={styles.section} aria-labelledby="focused-approval-heading">
          <div className={styles.sectionHeader}>
            <h2 id="focused-approval-heading">The approval you opened</h2>
            <p>
              {returnTo
                ? "Decide it here. Once the decision goes through, you go back to where you came from."
                : "Decide it here. The rest of the queue follows."}
            </p>
          </div>
          {!focused ? (
            <div className={styles.emptyState}>
              Loading the approval you opened…
            </div>
          ) : focused.status === "error" ? (
            <p className={styles.error} role="alert">
              {focused.message}
            </p>
          ) : focused.status === "missing" ? (
            <div className={styles.emptyState} data-focused="missing">
              <p>
                This approval is no longer waiting. It was decided, withdrawn,
                or expired.
              </p>
              {returnTo ? (
                <Link href={returnTo} className={styles.textLink}>
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
        <section className={styles.section} aria-labelledby={ACCESS_LIST_HEADING_ID}>
          <div className={styles.sectionHeader}>
            <h2 id={ACCESS_LIST_HEADING_ID} tabIndex={-1}>Workspace access</h2>
            <p>Review who is asking to join this tenant.</p>
          </div>
          {state === "ready" && !accessRequests.length ? (
            <div className={styles.emptyState}>
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
        <section className={styles.section} aria-labelledby={ACTION_LIST_HEADING_ID}>
          <div className={styles.sectionHeader}>
            <h2 id={ACTION_LIST_HEADING_ID} tabIndex={-1}>Agent and workflow actions</h2>
            <p>Review new approvals and safely reconcile previously approved actions with unresolved outcomes. The riskiest and longest-waiting come first.</p>
          </div>
          {state === "ready" && !items.length ? (
            <div className={styles.emptyState}>
              {focusedItem ? "Nothing else is waiting." : "No pending action approvals."}
            </div>
          ) : null}
          {items.map((item) => approvalCard(item))}
          {queue?.nextCursor ? (
            <div className={styles.pagination}>
              <p>
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
                <p>Decide some of these to see the rest.</p>
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
  const headingId = approvalHeadingId(accessRequestKey(item));
  const consequenceId = `${headingId}-consequence`;
  return (
    <article className={styles.decision} data-daybook="approval-item" aria-labelledby={headingId}>
      <header className={styles.decisionHeader}>
        <div className={styles.titleRow}>
          <h3 id={headingId} tabIndex={-1} className={styles.itemTitle}>{item.name}</h3>
          <span className={clsx(styles.badge, styles.warning)}>
            {needsProvisioning ? "provisioning needed" : "access request"}
          </span>
        </div>
        <p className={styles.metadata}>{item.email} · {item.company}</p>
        <p className={styles.metadata}>
          Requested {formatTime(item.createdAt)} · {accessRoleLabel(item.role)} · {timelineLabel(item.timeline)}
        </p>
      </header>
      <div className={styles.useCase}>
        <p className={styles.detailLabel}>What they want to do</p>
        <p>{item.useCase}</p>
      </div>
      {needsProvisioning ? (
        <div className={styles.decisionControls}>
          <p id={consequenceId} className={clsx(styles.policyNote, styles.warning)}>
            Access is approved. Finish creating the workspace identity; this
            request stays here until provisioning succeeds.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={onProvision}
              aria-describedby={consequenceId}
              className="primary-button"
            >
              <UserPlus size={14} aria-hidden="true" />
              Resume provisioning
            </button>
          </div>
        </div>
      ) : (
        <>
          <p id={consequenceId} className={styles.accessConsequence}>
            Approving records the decision and keeps this request in Approvals
            until the workspace identity is provisioned.
          </p>
          <div className={styles.decisionControls}>
            <label className={styles.field}>
              <span>Review note</span>
              <input
                value={note}
                onChange={(event) => onNote(event.target.value)}
                placeholder="Optional review note"
                aria-label={`Review note for ${item.name}`}
              />
            </label>
            <div className={styles.actions}>
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
                aria-describedby={consequenceId}
                className="primary-button"
              >
                {inFlight === "approved" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                Approve request
              </button>
            </div>
          </div>
          {inFlight ? <p className={styles.pending}>Recording decision…</p> : null}
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
