import type postgres from "postgres";
import { expect } from "vitest";
import { ensureMemoryLifecycleMaintenanceV1 } from "@/lib/db/schema/memory";
import type { SqlClient } from "@/lib/db/sql-types";

/** Recreate the real pre-v227 schema only in an empty disposable fixture. */
export async function removeEmptyMemoryPromotionForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS receipts
    FROM public.omni_memory_promotion_reviews WHERE native_decision IS NOT NULL`)
    .toEqual([{ receipts: 0 }]);
  await sql`DROP TRIGGER aa_omni_memory_promotion_native_validate ON public.omni_memory_promotion_reviews`;
  await sql`DROP FUNCTION public.omni_validate_memory_promotion_native_v1()`;
  await sql`DROP FUNCTION public.omni_memory_promotion_source_snapshot_v1(TEXT,TEXT,TEXT[],BOOLEAN)`;
  await sql`DROP INDEX public.omni_memory_promotion_native_key`;
  // Capture only the two replaced policies and validator from the maintained
  // pre-native baseline. Re-running that entire migration would also rewrite
  // unrelated lifecycle policies and falsify the historical catalog fixture.
  const statements: string[] = [];
  const capture = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    expect(values).toHaveLength(0);
    statements.push(strings.join(""));
    return [];
  }, { query: async (text: string) => { statements.push(text); return []; } });
  await ensureMemoryLifecycleMaintenanceV1(capture as unknown as SqlClient);
  const restoration = statements.filter((statement) =>
    /CREATE OR REPLACE FUNCTION\s+omni_validate_memory_promotion_review\(\)/.test(statement) ||
    /(?:CREATE POLICY|DROP POLICY IF EXISTS)\s+omni_memory_promotion_reviews_(?:actor_scope|update_purpose)\b/.test(statement));
  expect(restoration).toHaveLength(5);
  for (const statement of restoration) await sql.unsafe(statement);
  await sql`ALTER TABLE public.omni_memory_promotion_reviews
    DROP CONSTRAINT omni_memory_promotion_native_shape, DROP COLUMN native_decision`;
}
