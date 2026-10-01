"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  permissionMessage,
  useWorkspaceSession,
} from "@/components/app-shell/session-context";
import {
  ApprovalCard,
  DecisionNoticeRegion,
} from "@/components/approvals/approval-card";
import {
  decideAndReread,
  fetchApprovalQueueItem,
  type ApprovalDecision,
  type ApprovalItem,
  type DecisionNotice,
  type TrustResponse,
} from "@/components/approvals/approval-decision";
import { approvalInboxHref } from "@/lib/approvals/inbox-link";

export type InlineApprovalLoad =
  | { status: "ready"; item?: ApprovalItem; trust?: TrustResponse }
  | { status: "error" };

/**
 * The tool call a run paused on, decided where the run is shown. Someone who
 * cannot decide it, or a call that cannot be read here, gets the link to the
 * inbox instead.
 */
export function InlineApproval({
  executionId,
  summary,
  returnTo,
}: {
  executionId: string;
  /** What the run said it is waiting for. */
  summary: string;
  /** The conversation to come back to from the inbox. */
  returnTo?: string;
}) {
  const { session, status: sessionStatus, role } = useWorkspaceSession();
  const decisionPermission = permissionMessage(session, sessionStatus, "manage.workflow");
  const [loaded, setLoaded] = useState<InlineApprovalLoad>();
  const [reason, setReason] = useState("");
  const [inFlight, setInFlight] = useState<ApprovalDecision>();
  const [notice, setNotice] = useState<DecisionNotice>();
  const [decisionError, setDecisionError] = useState<string>();

  useEffect(() => {
    if (decisionPermission) return;
    let current = true;
    void Promise.all([
      fetchApprovalQueueItem({ id: executionId, kind: "tool" }),
      readTrust(),
    ]).then(
      ([item, trust]) => {
        if (current) setLoaded({ status: "ready", item, trust });
      },
      () => {
        if (current) setLoaded({ status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [decisionPermission, executionId]);

  async function decide(item: ApprovalItem, decision: ApprovalDecision) {
    setInFlight(decision);
    setDecisionError(undefined);
    try {
      const result = await decideAndReread(item, decision, { reason });
      setNotice(result.notice);
      setReason("");
      setLoaded((current) => ({
        status: "ready",
        item: result.item,
        trust: current?.status === "ready" ? current.trust : undefined,
      }));
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Decision failed.");
    } finally {
      setInFlight(undefined);
    }
  }

  const { loading, unavailable, item, trust } = inlineApprovalState(decisionPermission, loaded, notice);
  return (
    <InlineApprovalView
      summary={summary}
      inboxHref={approvalInboxHref({ id: executionId, kind: "tool", returnTo })}
      loading={loading}
      unavailable={unavailable}
      notice={notice}
      decisionError={decisionError}
      card={item ? (
        <ApprovalCard
          item={item}
          trust={trust?.profiles.find((profile) => profile.toolId === item.record?.toolId)}
          trustEnabled={trust?.enabled}
          threshold={trust?.threshold}
          approverRole={role}
          approverId={session?.context?.actorId}
          reason={reason}
          onReason={setReason}
          breakGlass={false}
          onBreakGlass={() => undefined}
          ticket=""
          onTicket={() => undefined}
          onDecide={(decision) => void decide(item, decision)}
          inFlight={inFlight}
        />
      ) : undefined}
    />
  );
}

/**
 * What the banner shows. Without the permission to decide, it is only the
 * link; once the call is read, the card, or why there is none.
 */
export function inlineApprovalState(
  decisionPermission: string | undefined,
  loaded: InlineApprovalLoad | undefined,
  notice: DecisionNotice | undefined,
) {
  if (decisionPermission) {
    return { loading: false };
  }
  if (!loaded) {
    return { loading: true };
  }
  if (loaded.status === "error") {
    return {
      loading: false,
      unavailable: "The approval could not be loaded here. Review it in the inbox.",
    };
  }
  return {
    loading: false,
    item: loaded.item,
    trust: loaded.trust,
    // After a decision the notice says what happened to it.
    unavailable: loaded.item || notice ? undefined : "This approval is no longer waiting.",
  };
}

export function InlineApprovalView({
  summary,
  inboxHref,
  loading = false,
  unavailable,
  notice,
  decisionError,
  card,
}: {
  summary: string;
  inboxHref: string;
  loading?: boolean;
  /** Why the approval is not decided here, when that needs saying. */
  unavailable?: string;
  notice?: DecisionNotice;
  decisionError?: string;
  card?: ReactNode;
}) {
  return (
    <section
      className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3"
      aria-label="Approval needed"
      data-inline-approval={card ? "card" : "link"}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Approval needed</p>
            <p className="mt-1 text-xs leading-5 text-muted">{summary}</p>
          </div>
        </div>
        <Link href={inboxHref} className="action-link shrink-0">
          {card ? "Open in Inbox" : "Review"}
        </Link>
      </div>
      <DecisionNoticeRegion notice={notice} className="mt-3 rounded-md border px-3 py-2 text-sm" />
      {decisionError ? (
        <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {decisionError}
        </p>
      ) : null}
      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Loading the approval…
        </p>
      ) : null}
      {unavailable ? <p className="mt-3 text-xs leading-5 text-muted">{unavailable}</p> : null}
      {card ? <div className="mt-3">{card}</div> : null}
    </section>
  );
}

async function readTrust() {
  try {
    const response = await fetch("/api/trust");
    return response.ok ? ((await response.json()) as TrustResponse) : undefined;
  } catch {
    return undefined;
  }
}
