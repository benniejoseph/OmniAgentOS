import type { AuthorizedA2APrincipal } from "@/lib/a2a/auth";
import { A2AProtocolError } from "@/lib/a2a/v1-contracts";
import {
  A2A_PEER_DAILY_MAX_COST_MICROUSD,
  A2A_PEER_DAILY_MAX_TOKENS,
  A2A_PEER_TASKS_PER_HOUR,
  TENANT_DAILY_MAX_COST_MICROUSD,
  TENANT_DAILY_MAX_TOKENS,
} from "@/lib/config";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  loadTenantAiUsageSince,
  type TenantAiUsageTotals,
} from "@/lib/usage/allowance";

const TASK_START_WINDOW_MS = 60 * 60 * 1_000;
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * The usage-ledger stream that meters a peer's inbound tasks. It names the
 * peer by digest, so a long peer ID still fits the ledger's stream ID.
 */
export function inboundA2AUsageStreamId(principal: AuthorizedA2APrincipal) {
  return `a2a-peer:${canonicalJsonSha256({ peerId: principal.peer.peerId })}`;
}

/**
 * Admit a new inbound task only while its peer has task starts left in the
 * hour and the task's whole budget fits both the peer's and the workspace's
 * AI usage over the last 24 hours. A caller from outside never runs
 * unmetered: a check that cannot be made refuses the task.
 */
export async function admitInboundA2ATask(
  principal: AuthorizedA2APrincipal,
  taskBudget: TenantAiUsageTotals,
) {
  const starts = await checked(() => checkSharedRateLimit({
    key: `a2a-task:${principal.tenantId}:${principal.peer.peerId}`,
    limit: A2A_PEER_TASKS_PER_HOUR,
    windowMs: TASK_START_WINDOW_MS,
  }));
  if (!starts.allowed) {
    throw new A2AProtocolError(
      "This peer has started as many A2A tasks as it may this hour. Try again later.",
      429,
      "resource_exhausted",
    );
  }
  const since = new Date(Date.now() - USAGE_WINDOW_MS);
  const peerUsage = await checked(() => loadTenantAiUsageSince({
    tenantId: principal.tenantId,
    since,
    sourceStreamId: inboundA2AUsageStreamId(principal),
  }));
  if (exceeds(peerUsage, taskBudget, {
    tokens: A2A_PEER_DAILY_MAX_TOKENS,
    costMicrousd: A2A_PEER_DAILY_MAX_COST_MICROUSD,
  })) {
    throw new A2AProtocolError(
      "This peer's AI usage over the last 24 hours leaves no room for another task.",
      429,
      "resource_exhausted",
    );
  }
  const workspaceUsage = await checked(() => loadTenantAiUsageSince({
    tenantId: principal.tenantId,
    since,
  }));
  if (exceeds(workspaceUsage, taskBudget, {
    tokens: TENANT_DAILY_MAX_TOKENS,
    costMicrousd: TENANT_DAILY_MAX_COST_MICROUSD,
  })) {
    throw new A2AProtocolError(
      "The workspace's AI usage over the last 24 hours leaves no room for another A2A task.",
      429,
      "resource_exhausted",
    );
  }
}

function exceeds(
  used: TenantAiUsageTotals,
  taskBudget: TenantAiUsageTotals,
  limit: TenantAiUsageTotals,
) {
  return used.tokens + taskBudget.tokens > limit.tokens ||
    used.costMicrousd + taskBudget.costMicrousd > limit.costMicrousd;
}

async function checked<T>(check: () => Promise<T>) {
  try {
    return await check();
  } catch {
    throw new A2AProtocolError(
      "The A2A task budget could not be checked. Try again shortly.",
      503,
      "unavailable",
    );
  }
}
