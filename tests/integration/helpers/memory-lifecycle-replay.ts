import type postgres from "postgres";
import { expect } from "vitest";

/** Remove only an empty v222 ledger from a disposable historical fixture.
 * Real acceptance evidence is never erased to make a migration replay pass. */
export async function removeEmptyMemoryLifecycleForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS receipts
    FROM public.omni_memory_lifecycle_mutations`).toEqual([{ receipts: 0 }]);
  await sql`DROP TRIGGER omni_memory_deletion_receipts_lifecycle_scrub ON public.omni_memory_deletion_receipts`;
  await sql`DROP TRIGGER omni_memory_deletion_receipts_lifecycle_mutations ON public.omni_memory_deletion_receipts`;
  await sql`DROP TRIGGER zz_omni_memory_lifecycle_target_revision ON public.omni_memories`;
  await sql`DROP TRIGGER zz_omni_memory_lifecycle_revision ON public.omni_memory_lifecycle_states`;
  await sql`DROP TABLE public.omni_memory_lifecycle_mutations`;
  await sql`DROP FUNCTION public.omni_require_memory_lifecycle_forget_scrub_v1()`;
  await sql`DROP FUNCTION public.omni_scrub_memory_lifecycle_mutations_v1()`;
  await sql`DROP FUNCTION public.omni_memory_lifecycle_mutation_guard_v1()`;
  await sql`DROP FUNCTION public.omni_memory_lifecycle_revision_v1()`;
  await sql`DROP FUNCTION public.omni_memory_lifecycle_target_revision_v1()`;
  await sql`ALTER TABLE public.omni_memory_lifecycle_states DROP COLUMN lifecycle_revision`;
  await sql`ALTER TABLE public.omni_memories DROP COLUMN lifecycle_target_revision`;
}
