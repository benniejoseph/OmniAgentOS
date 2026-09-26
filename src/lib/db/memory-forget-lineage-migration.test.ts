import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ensureMemoryForgetLineageClosureV1 } from "./memory-forget-lineage-schema";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260926090000_memory_forget_lineage_closure.sql",
);

const definers = [
  "omni_memory_reference_shares_owner_v1",
  "omni_memory_deletion_manifest_v1",
  "omni_apply_memory_deletion_receipt",
  "omni_validate_memory_deletion_receipt_end_state",
  "omni_scrub_memory_lifecycle_lineage",
  "omni_lease_memory_deletion_scrub_receipts",
] as const;

function functionSection(source: string, name: string) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("$function$;", start);
  expect(end, name).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("memory forget lineage closure migration v207", () => {
  it("is contiguous with v206 and uses the repository name digest", async () => {
    const source = await readFile(migrationPath, "utf8");
    const name = "memory_forget_lineage_closure_v1";
    const checksum = createHash("sha256").update(name).digest("hex");

    expect(checksum).toBe(
      "980dfe0af300eac5072cf0bf6b5f80b6a4e5335f444f0046732e7291f3f26c36",
    );
    expect(source).toContain("latest_version IS DISTINCT FROM 206");
    expect(source).toContain("name = 'prompt_queue_context_pins_v1'");
    expect(source).toContain(
      "checksum = '5de8d38921e0d4d0f7e79bcfe4745f780ce973b009c874a519d09bfd8f3ff777'",
    );
    expect(source).toContain("VALUES (\n  207,\n  'memory_forget_lineage_closure_v1'");
    expect(source).toContain(`'${checksum}'`);
  });

  it("computes the closure in a tenant-bound definer that returns identifiers only", async () => {
    const source = await readFile(migrationPath, "utf8");
    const manifest = functionSection(source, "omni_memory_deletion_manifest_v1");

    expect(manifest).toContain("SECURITY DEFINER");
    expect(manifest).toContain(
      "row_tenant_id IS DISTINCT FROM public.omni_current_tenant()",
    );
    expect(manifest).toContain(
      "RETURNS TABLE (\n  descendant_memory_ids TEXT[],\n  retrieval_trace_ids TEXT[],\n"
        + "  graph_node_ids TEXT[],\n  graph_edge_ids TEXT[]\n)",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION public.omni_memory_deletion_manifest_v1(TEXT, TEXT)\nFROM PUBLIC;",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION public.omni_apply_memory_deletion_receipt()\nFROM PUBLIC;",
    );
    expect(source).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.omni_memory_deletion_manifest_v1\(TEXT, TEXT\)\s+TO omni_runtime;/,
    );
    expect(source).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.omni_memory_deletion_manifest_v1\(TEXT, TEXT\)\s+TO omni_maintenance;/,
    );
  });

  it("validates a receipt without deleting and applies it after the insert", async () => {
    const source = await readFile(migrationPath, "utf8");
    const validator = functionSection(source, "omni_validate_memory_deletion_receipt");
    const apply = functionSection(source, "omni_apply_memory_deletion_receipt");

    expect(validator).toContain("SECURITY INVOKER");
    expect(validator).toContain("omni_memory_deletion_manifest_v1");
    expect(validator).not.toContain("DELETE FROM");
    expect(apply).toContain("SECURITY DEFINER");
    for (const table of [
      "omni_memory_graph_edges",
      "omni_memory_graph_nodes",
      "omni_retrieval_traces",
      "omni_agent_memory_grants",
    ]) {
      expect(apply).toContain(`DELETE FROM public.${table}`);
    }
    expect(apply).toContain("= ANY(NEW.blocked_memory_ids)");
    expect(source).toContain(
      "AFTER INSERT ON public.omni_memory_deletion_receipts\nFOR EACH ROW\n"
        + "EXECUTE FUNCTION public.omni_apply_memory_deletion_receipt();",
    );
    expect(source).toContain(
      "public.omni_validate_memory_deletion_receipt()'::regprocedure\n"
        + "      AND procedure.prosrc LIKE '%DELETE FROM%'",
    );
  });

  it("raises system scope only inside definer bodies and restores it", async () => {
    const source = await readFile(migrationPath, "utf8");

    // A non-superuser owner cannot attach omni.* settings to a function.
    expect(source).not.toMatch(/^\s*SET omni\./m);
    for (const name of definers) {
      const body = functionSection(source, name);
      expect(body, name).toContain("SECURITY DEFINER\nSET search_path = pg_catalog, public\n");
      for (const [setting, previous] of [
        ["omni.system_scope", "previous_system_scope"],
        ["omni.memory_deletion_lineage", "previous_deletion_lineage"],
      ] as const) {
        if (body.includes(`set_config('${setting}', 'true', TRUE)`)) {
          expect(body, `${name} ${setting}`).toContain(
            `'${setting}',\n    COALESCE(${previous}, ''),\n    TRUE`,
          );
        }
      }
    }
  });

  it("lets an owner forget an agent's private memory under a validated forget scope", async () => {
    const source = await readFile(migrationPath, "utf8");
    const owner = functionSection(source, "omni_agent_private_memory_owner_forget_v1_allows");

    expect(owner).toContain("SECURITY INVOKER");
    expect(owner).toContain("omni_user_private_memory_scope_v1_allows_validated(");
    expect(owner).toContain("ARRAY['memory.forget.v1']::TEXT[]");
    expect(source).toContain("ALTER POLICY omni_memory_access_scope_holdback ON public.omni_memories");
    expect(source).toContain("ALTER POLICY omni_memory_deletion_barrier ON public.omni_memories");
  });

  it("applies the migration body at runtime without the ledger or transaction wrapper", async () => {
    const query = vi.fn(async (text: string) => {
      void text;
      return [] as Record<string, unknown>[];
    });

    await ensureMemoryForgetLineageClosureV1({ query });

    expect(query).toHaveBeenCalledTimes(1);
    const body = query.mock.calls[0]?.[0] ?? "";
    expect(body.startsWith("-- Forget computes one lineage closure over every visibility.")).toBe(true);
    expect(body.endsWith("$verify$;")).toBe(true);
    expect(body).not.toContain("INSERT INTO public.omni_schema_version");
    expect(body).not.toContain("pg_advisory_xact_lock(271828182)");
    expect(body).not.toContain("COMMIT;");
    expect(body).toContain("CREATE TRIGGER omni_memory_deletion_receipts_apply");
  });
});
