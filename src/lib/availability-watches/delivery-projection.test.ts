import { describe, expect, it, vi } from "vitest";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
vi.mock("@/lib/web-push/store", () => ({}));
vi.mock("@/lib/today/notifications", () => ({}));
vi.mock("@/lib/mobile/notification-decision-events", () => ({}));
vi.mock("@/lib/mobile/notification-disposition-store", () => ({}));
vi.mock("@/lib/mobile/notification-owner", () => ({}));
vi.mock("@/lib/mobile/push-store", () => ({}));
vi.mock("@/lib/mobile/push-providers", () => ({ mobilePushProviderConfiguration: () => ({ apns: "configured", fcm: "configured" }) }));
import { readAvailabilityWatchesPushStatusWithSql } from "./notifications";

const owner = { tenantId: "synthetic-tenant", actorId: "synthetic-owner" };
function database(responses: SqlRow[][]) {
  return vi.fn(async (_strings: TemplateStringsArray, ..._params: unknown[]) => responses.shift() ?? []) as unknown as SqlClient & ReturnType<typeof vi.fn>;
}
describe("batched watch delivery projection", () => {
  it.each([1, 40, 100])("reads %s opening projections in two queries with one owner device count", async count => {
    const watches = Array.from({ length: count }, (_, i) => ({ watchId: `watch-${i}`, openingId: `opening-${i}` }));
    const sql = database([[{ watch_id: "watch-0", opening_id: "opening-0", queued: 2, received: 1, opened: 0, accepted: 1 }], [{ count: 3 }]]);
    const result = await readAvailabilityWatchesPushStatusWithSql(sql, owner, watches);
    expect(sql).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(count);
    expect(result.get("watch-0")).toMatchObject({ queued: 2, received: 1, providerAccepted: 1, eligibleDevices: 3 });
    if (count > 1) expect(result.get(`watch-${count - 1}`)).toMatchObject({ queued: 0, received: 0, eligibleDevices: 3 });
    const params = sql.mock.calls[0].slice(1);
    expect(params).toContain(owner.tenantId);
    expect(params).toContain(owner.actorId);
    expect(params).toContainEqual(watches);
  });
  it("never associates another opening's counters with this watch", async () => {
    const sql = database([[{ watch_id: "watch-0", opening_id: "older-opening", received: 8 }], [{ count: 1 }]]);
    const result = await readAvailabilityWatchesPushStatusWithSql(sql, owner, [{ watchId: "watch-0", openingId: "new-opening" }]);
    expect(result.get("watch-0")?.received).toBe(0);
  });
  it("skips delivery scans for watches which have no opening", async () => {
    const sql = database([[{ count: 2 }]]);
    const result = await readAvailabilityWatchesPushStatusWithSql(sql, owner, [{ watchId: "watch-0", openingId: null }]);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(result.get("watch-0")).toMatchObject({ queued: 0, received: 0, eligibleDevices: 2 });
  });
  it("does no IO for an empty list and rejects an unbounded or ambiguous projection", async () => {
    const sql = database([]);
    expect((await readAvailabilityWatchesPushStatusWithSql(sql, owner, [])).size).toBe(0);
    const watch = { watchId: "watch-0", openingId: null };
    await expect(readAvailabilityWatchesPushStatusWithSql(sql, owner, [watch, watch])).rejects.toThrow("distinct watches");
    await expect(readAvailabilityWatchesPushStatusWithSql(sql, owner, Array.from({ length: 101 }, (_, i) => ({ ...watch, watchId: String(i) })))).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
});
