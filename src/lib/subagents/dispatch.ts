import { after } from "next/server";
import { requestWorkDeadline } from "@/lib/observability/request-timing";
import {
  DURABLE_SPECIALIST_BUDGET_MS,
  processAllTenantDurableSpecialistQueues,
} from "@/lib/subagents/worker";

/** Register bounded specialist work without borrowing the fast tick's deadline. */
export function scheduleDurableSpecialistQueueDrain(input: {
  tenantIds: readonly string[];
  limit: number;
  routeMaxDurationSeconds: number;
}) {
  const limit = Math.min(Math.max(Math.round(input.limit), 1), 10);
  const tenantIds = [...new Set(input.tenantIds.map(id => id.trim()).filter(Boolean))]
    .slice(0, limit);
  const deadlineAt = Math.min(
    requestWorkDeadline(input.routeMaxDurationSeconds),
    Date.now() + DURABLE_SPECIALIST_BUDGET_MS,
  );
  let scheduled = 0;
  if (tenantIds.length && deadlineAt - Date.now() >= DURABLE_SPECIALIST_BUDGET_MS - 1_000) {
    // Next's promise form keeps already-started work alive after the response.
    // Start only once registration succeeds, but before unrelated tick work can
    // consume a child's short acceptance window. Existing atomic queue leases
    // still exclude duplicate execution across overlapping scheduler requests.
    let registered = false;
    const work = Promise.resolve().then(async () => {
      if (!registered) return;
      const timeBudgetMs = deadlineAt - Date.now();
      if (timeBudgetMs < DURABLE_SPECIALIST_BUDGET_MS - 1_000) return;
      try {
        const result = await processAllTenantDurableSpecialistQueues({
          tenantIds, limit, timeBudgetMs,
        });
        console.info(JSON.stringify({
          level: "info", msg: "durable_specialist_dispatch_completed",
          leased: result.leased, completed: result.completed,
          failed: result.failed, stale: result.stale,
        }));
      } catch {
        console.warn("Durable specialist dispatch failed; inspect its durable job receipts before retrying.");
      }
    });
    after(work);
    registered = true;
    scheduled = 1;
  }
  // Scheduling is not evidence of a lease, model call, or completed task.
  return { tenantIds, tenantResults: [], scheduled, leased: 0,
    completed: 0, failed: 0, stale: 0 };
}
