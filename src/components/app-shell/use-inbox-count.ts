"use client";

import { useEffect, useState } from "react";
import {
  canPerform,
  useWorkspaceSession,
  type WorkspaceRole,
  type WorkspaceSession,
} from "@/components/app-shell/session-context";
import {
  INBOX_CHANGED_EVENT,
  readInboxCount,
  type InboxCount,
} from "@/lib/approvals/inbox-link";
import {
  browserRefreshEnvironment,
  startVisibleRefresh,
  type VisibleRefreshEnvironment,
} from "@/lib/client/visible-refresh";

/** The first count waits for the page to settle; later ones follow the poll. */
export const INITIAL_INBOX_COUNT_DELAY_MS = 2_000;
export const INBOX_COUNT_POLL_MS = 30_000;

export type InboxCountEnvironment = VisibleRefreshEnvironment & {
  addChangeListener: (listener: () => void) => void;
  removeChangeListener: (listener: () => void) => void;
};

const browserInboxCountEnvironment: InboxCountEnvironment = {
  ...browserRefreshEnvironment,
  addChangeListener: (listener) => window.addEventListener(INBOX_CHANGED_EVENT, listener),
  removeChangeListener: (listener) => window.removeEventListener(INBOX_CHANGED_EVENT, listener),
};

/**
 * Whose inbox the badge counts: a signed-in session whose role may decide
 * something the inbox holds. Anyone else gets no badge and sends no request.
 */
export function inboxCountKey(
  session: WorkspaceSession | undefined,
  status: ReturnType<typeof useWorkspaceSession>["status"],
  role: WorkspaceRole,
) {
  if (status !== "ready" || !session || (session.authEnabled && !session.authenticated)) {
    return undefined;
  }
  if (!canPerform(role, "manage.workflow") && !canPerform(role, "manage.identity")) {
    return undefined;
  }
  return [session.context?.tenantId ?? "", session.context?.actorId ?? "", role].join(":");
}

export async function fetchInboxCount(signal?: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/inbox", { cache: "no-store", signal });
  if (!response.ok) {
    return undefined;
  }
  return readInboxCount(await response.json().catch(() => undefined));
}

/**
 * Counts the inbox once the page settles, on each poll while it is visible,
 * and whenever a decision announces a change. A newer count replaces one
 * still in flight, and a failed count keeps the last one: the badge is a
 * hint, and the next count corrects it.
 */
export function startInboxCount({
  onCount,
  fetchCount = fetchInboxCount,
  environment = browserInboxCountEnvironment,
}: {
  onCount: (count: InboxCount) => void;
  fetchCount?: (signal: AbortSignal) => Promise<InboxCount | undefined>;
  environment?: InboxCountEnvironment;
}) {
  let disposed = false;
  let inFlight: AbortController | undefined;

  const load = async () => {
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    try {
      const count = await fetchCount(request.signal);
      if (!disposed && inFlight === request && count) {
        onCount(count);
      }
    } catch {
      // Keep the last count.
    } finally {
      if (inFlight === request) {
        inFlight = undefined;
      }
    }
  };

  const initial = environment.setTimer(() => {
    if (environment.isVisible()) {
      void load();
    }
  }, INITIAL_INBOX_COUNT_DELAY_MS);
  const stopRefresh = startVisibleRefresh({
    onRefresh: load,
    pollIntervalMs: INBOX_COUNT_POLL_MS,
    environment,
  });
  const onChange = () => void load();
  environment.addChangeListener(onChange);

  return () => {
    disposed = true;
    environment.clearTimer(initial);
    stopRefresh();
    environment.removeChangeListener(onChange);
    inFlight?.abort();
  };
}

/** What waits in the inbox for this session, once counted. */
export function useInboxCount() {
  const { session, status, role } = useWorkspaceSession();
  const key = inboxCountKey(session, status, role);
  const [counted, setCounted] = useState<{ key: string; count: InboxCount }>();

  useEffect(() => {
    if (!key) {
      return;
    }
    return startInboxCount({ onCount: (count) => setCounted({ key, count }) });
  }, [key]);

  // A count read for another account or role is not shown.
  return key && counted?.key === key ? counted.count : undefined;
}
