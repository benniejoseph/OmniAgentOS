import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260916120000_market_deterministic_backtests.sql",
  ),
  "utf8",
);

describe("market deterministic backtest schema", () => {
  it("creates an actor-private append-only result and typed event boundary", () => {
    expect(migration).toContain("CREATE TABLE public.omni_market_backtests");
    expect(migration).toContain("CREATE TABLE public.omni_market_backtest_events");
    expect(migration).toContain("market.backtest.completed");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON public.omni_market_backtests TO omni_runtime",
    );
    expect(migration).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public");
    expect(migration).toContain("Backup role table coverage is incomplete");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE");
    expect(migration).toContain("Market backtest isolation boundary is invalid");
  });
});
