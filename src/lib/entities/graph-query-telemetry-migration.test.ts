import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("P5.6 graph query telemetry migration", () => {
  it("pins an actor-private, append-only runtime boundary", async () => {
    const source = await readFile("src/lib/db/client.ts", "utf8");
    const start = source.indexOf("async function ensureGraphQueryTelemetryV1");
    const end = source.indexOf("async function ensureEntityRegistryV1", start);
    const migration = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS omni_graph_query_telemetry");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_graph_query_telemetry TO omni_runtime");
    expect(migration).toContain("privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE ON omni_graph_query_telemetry TO omni_runtime");
  });
});
