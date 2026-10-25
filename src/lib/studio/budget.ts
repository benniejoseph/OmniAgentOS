import { createHash } from "node:crypto";
import { TENANT_DAILY_MAX_COST_MICROUSD } from "@/lib/config";
import { getDataPath } from "@/lib/storage/paths";
import { updateJsonFile } from "@/lib/storage/json";
import { listFileAiUsageRecords } from "@/lib/usage/ledger";
import { StudioError, type StudioOwner } from "./server-types";
import type { StudioTransaction } from "./store";

type Reservation = { id: string; maximumMicrousd: number; createdAt: string };
/** Conservative rolling-day holds remain reserved even when a provider's outcome is uncertain. */
export async function reserveStudioBudget(
  tx: StudioTransaction,
  owner: StudioOwner,
  runId: string,
  maximumUsd: number | null,
  dailyLimit = TENANT_DAILY_MAX_COST_MICROUSD,
) {
  const id = createHash("sha256").update(runId).digest("hex");
  const since = new Date(Date.now() - 86_400_000).toISOString();
  if (tx.sql) {
    const sql = tx.sql;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`studio-budget:${owner.tenantId}`},0))`;
    const existing =
      await sql`SELECT reservation_id FROM omni_studio_budget_reservations WHERE tenant_id=${owner.tenantId} AND reservation_id=${id}`;
    if (existing.length) return;
    const rows =
      await sql`SELECT * FROM public.omni_studio_budget_totals_v1(${owner.tenantId},${owner.actorId},${since}::timestamptz)`;
    const maximumMicrousd = acceptedCost(
      maximumUsd,
      Number(rows[0].other_cost) + Number(rows[0].reserved_cost),
      dailyLimit,
    );
    await sql`INSERT INTO omni_studio_budget_reservations(tenant_id,reservation_id,maximum_microusd) VALUES(${owner.tenantId},${id},${maximumMicrousd})`;
    return;
  }
  // The development fallback also serializes different owners in one tenant. A crash can
  // conservatively retain an unused hold, but can never release an uncertain paid request.
  const file = getDataPath(
    "studio",
    `budget-${createHash("sha256").update(owner.tenantId).digest("hex")}.json`,
  );
  await updateJsonFile<{ reservations: Reservation[] }>(
    file,
    { reservations: [] },
    async (ledger) => {
      ledger.reservations = ledger.reservations.filter(
        (r) => r.createdAt >= since,
      );
      if (ledger.reservations.some((r) => r.id === id)) return ledger;
      const usage = await listFileAiUsageRecords({
        tenantId: owner.tenantId,
        limit: 10_000,
      });
      const other = usage
        .filter(
          (u) =>
            u.recordedAt >= since && !u.sourceStreamId.startsWith("studio:"),
        )
        .reduce((sum, u) => sum + (u.estimatedCostMicrousd ?? 0), 0);
      const reserved = ledger.reservations.reduce(
        (sum, r) => sum + r.maximumMicrousd,
        0,
      );
      ledger.reservations.push({
        id,
        maximumMicrousd: acceptedCost(maximumUsd, other + reserved, dailyLimit),
        createdAt: new Date().toISOString(),
      });
      return ledger;
    },
  );
}
function acceptedCost(maximumUsd: number | null, used: number, limit: number) {
  const amount =
    maximumUsd === null
      ? Math.max(0, limit - used)
      : Math.ceil(maximumUsd * 1_000_000);
  if (
    !Number.isFinite(used) ||
    used < 0 ||
    used + amount > limit ||
    (maximumUsd === null && amount === 0)
  )
    throw new StudioError(
      "This run would exceed the workspace's daily AI allowance. Studio reserves the maximum quoted cost for 24 hours, including uncertain requests.",
      429,
      "studio_daily_budget",
    );
  return amount;
}
