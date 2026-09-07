ALTER TABLE public.omni_memory_deletion_receipts
ADD COLUMN IF NOT EXISTS blocked_memory_ids TEXT[]
GENERATED ALWAYS AS (
  ARRAY[memory_id] || descendant_memory_ids
) STORED;
CREATE INDEX IF NOT EXISTS omni_memory_deletion_receipts_blocked_ids_idx
ON public.omni_memory_deletion_receipts USING GIN (blocked_memory_ids);
CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_memory_ids_idx
ON public.omni_memory_graph_nodes USING GIN (memory_ids);
CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_trace_ids_idx
ON public.omni_memory_graph_nodes USING GIN (trace_ids);
CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_memory_ids_idx
ON public.omni_memory_graph_edges USING GIN (memory_ids);
CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_trace_ids_idx
ON public.omni_memory_graph_edges USING GIN (trace_ids);
CREATE OR REPLACE FUNCTION public.omni_memory_ids_have_deletion_barrier(
  row_tenant_id TEXT,
  row_memory_ids TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.omni_memory_deletion_receipts receipt
    WHERE receipt.tenant_id = row_tenant_id
      AND receipt.blocked_memory_ids &&
        COALESCE(row_memory_ids, '{}'::TEXT[])
  )
$function$;
REVOKE ALL ON FUNCTION public.omni_memory_ids_have_deletion_barrier(TEXT, TEXT[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.omni_memory_ids_have_deletion_barrier(TEXT, TEXT[])
TO PUBLIC;
INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  75,
  'memory_deletion_barrier_query_indexes',
  'c34aac5c2035a63afc8644f4e582ffcbb146b68c1e2debf14524424ee55198ed',
  NOW()
)
ON CONFLICT DO NOTHING;
