import type { InboxCount } from "@/lib/approvals/inbox-link";
import { getAccessRequestStore } from "@/lib/onboarding/access-request-store";
import { getApprovalQueue } from "@/lib/operations/queue";
import { canPerform } from "@/lib/security/context";
import type { SecurityRole } from "@/lib/security/types";

export type InboxCountDependencies = {
  countApprovals: (tenantId: string) => Promise<number>;
  countAccessRequests: (tenantId: string) => Promise<number>;
};

const defaultDependencies: InboxCountDependencies = {
  async countApprovals(tenantId) {
    return (await getApprovalQueue(1, { tenantId })).stats.total;
  },
  // The same two counts the inbox adds up for its own heading.
  async countAccessRequests(tenantId) {
    const store = getAccessRequestStore();
    const [pending, provisioning] = await Promise.all([
      store.count({ tenantId, status: "pending_review" }),
      store.count({ tenantId, status: "provisioning_pending" }),
    ]);
    return pending + provisioning;
  },
};

/**
 * How many items wait in the inbox for this caller. Each queue counts only
 * when the caller's role may decide its items, and a queue that cannot be
 * read is left out rather than failing the count: the badge is a hint, and
 * the inbox itself reports the error.
 */
export async function loadInboxCount(
  { tenantId, role }: { tenantId: string; role: SecurityRole },
  dependencies: Partial<InboxCountDependencies> = {},
): Promise<InboxCount> {
  const { countApprovals, countAccessRequests } = {
    ...defaultDependencies,
    ...dependencies,
  };
  const [approvals, accessRequests] = await Promise.all([
    canPerform(role, "manage.workflow")
      ? countOrOmit(() => countApprovals(tenantId))
      : undefined,
    canPerform(role, "manage.identity")
      ? countOrOmit(() => countAccessRequests(tenantId))
      : undefined,
  ]);
  return {
    pending: (approvals ?? 0) + (accessRequests ?? 0),
    ...(approvals === undefined ? {} : { approvals }),
    ...(accessRequests === undefined ? {} : { accessRequests }),
  };
}

async function countOrOmit(count: () => Promise<number>) {
  try {
    const value = await count();
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
