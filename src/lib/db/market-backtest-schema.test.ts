import { describe, expect, it, vi } from "vitest";

import {
  ensureMarketDeterministicBacktestsV1,
  type MarketBacktestSchemaSqlClient,
} from "@/lib/db/market-backtest-schema";

describe("market deterministic backtest schema", () => {
  it("creates an actor-private append-only result and typed event boundary", async () => {
    const queries: string[] = [];
    const tagged: string[] = [];
    const client = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        tagged.push(strings.join("?"));
        return [];
      }),
      {
        query: vi.fn(async (text: string) => {
          queries.push(text);
          return [];
        }),
      },
    ) as unknown as MarketBacktestSchemaSqlClient;

    await ensureMarketDeterministicBacktestsV1(client);

    const schema = queries.join("\n");
    const checks = tagged.join("\n");
    expect(schema).toContain("CREATE TABLE omni_market_backtests");
    expect(schema).toContain("CREATE TABLE omni_market_backtest_events");
    expect(schema).toContain("market.backtest.completed");
    expect(schema).toContain("FORCE ROW LEVEL SECURITY");
    expect(checks).toContain("GRANT SELECT, INSERT");
    expect(checks).not.toContain("GRANT UPDATE");
    expect(checks).not.toContain("GRANT DELETE");
    expect(checks).toContain("Market backtest isolation boundary is invalid");
  });
});
