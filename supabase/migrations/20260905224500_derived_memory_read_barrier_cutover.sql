DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.omni_retrieval_traces row_value
    JOIN public.omni_memory_deletion_receipts receipt
      ON receipt.tenant_id = row_value.tenant_id
     AND receipt.blocked_memory_ids && row_value.memory_ids
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_memory_graph_nodes row_value
    JOIN public.omni_memory_deletion_receipts receipt
      ON receipt.tenant_id = row_value.tenant_id
     AND receipt.blocked_memory_ids && row_value.memory_ids
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_memory_graph_edges row_value
    JOIN public.omni_memory_deletion_receipts receipt
      ON receipt.tenant_id = row_value.tenant_id
     AND receipt.blocked_memory_ids && row_value.memory_ids
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_memory_graph_edges edge
    LEFT JOIN public.omni_memory_graph_nodes source_node
      ON source_node.id = edge.source_node_id
     AND source_node.tenant_id = edge.tenant_id
    LEFT JOIN public.omni_memory_graph_nodes target_node
      ON target_node.id = edge.target_node_id
     AND target_node.tenant_id = edge.tenant_id
    WHERE source_node.id IS NULL OR target_node.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Derived memory rows violate the deletion-barrier cutover invariant'
      USING ERRCODE = '23514';
  END IF;
END
$migration$;
DROP POLICY IF EXISTS omni_memory_deletion_barrier
ON public.omni_retrieval_traces;
CREATE POLICY omni_memory_deletion_barrier
ON public.omni_retrieval_traces
AS RESTRICTIVE
FOR SELECT
USING (TRUE);
DROP POLICY IF EXISTS omni_memory_deletion_barrier
ON public.omni_memory_graph_nodes;
CREATE POLICY omni_memory_deletion_barrier
ON public.omni_memory_graph_nodes
AS RESTRICTIVE
FOR SELECT
USING (TRUE);
DROP POLICY IF EXISTS omni_memory_deletion_barrier
ON public.omni_memory_graph_edges;
CREATE POLICY omni_memory_deletion_barrier
ON public.omni_memory_graph_edges
AS RESTRICTIVE
FOR SELECT
USING (TRUE);
CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tenant_rank_idx
ON public.omni_memory_graph_nodes (
  tenant_id, weight DESC, source_count DESC, updated_at DESC
);
CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_tenant_rank_idx
ON public.omni_memory_graph_edges (
  tenant_id, weight DESC, evidence_count DESC, updated_at DESC
);
INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  76,
  'derived_memory_read_barrier_cutover',
  '2c9f41f2e651714203cc111b825aeaec85a335aed41ef9cd6fcead3d9afd7315',
  NOW()
)
ON CONFLICT DO NOTHING;
