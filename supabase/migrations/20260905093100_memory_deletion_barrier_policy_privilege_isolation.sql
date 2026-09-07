SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
CREATE OR REPLACE FUNCTION omni_memory_ids_have_deletion_barrier(
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
      AND (
        ARRAY[receipt.memory_id] || receipt.descendant_memory_ids
      ) && COALESCE(row_memory_ids, '{}'::TEXT[])
  )
$function$;
CREATE OR REPLACE FUNCTION omni_memory_has_deletion_receipt(
  row_tenant_id TEXT,
  row_memory_id TEXT
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
      AND receipt.memory_id = row_memory_id
  )
$function$;
DROP POLICY IF EXISTS omni_memory_deletion_barrier
ON omni_memories;
CREATE POLICY omni_memory_deletion_barrier
ON omni_memories
AS RESTRICTIVE
FOR SELECT
USING (
  NOT omni_memory_ids_have_deletion_barrier(tenant_id, ARRAY[id])
  OR omni_memory_has_deletion_receipt(tenant_id, id)
  OR (
    claim_status = 'forgotten'
    AND title = '[forgotten]'
    AND content = ''
    AND cardinality(tags) = 0
    AND source = '[forgotten]'
    AND embedding IS NULL
    AND cardinality(evidence_refs) = 0
    AND supersedes_id IS NULL
    AND contradiction_of_id IS NULL
    AND forgotten_at IS NOT NULL
    AND COALESCE(
      to_jsonb(omni_memories) -> 'embedding_vector',
      'null'::JSONB
    ) = 'null'::JSONB
  )
);
REVOKE ALL ON FUNCTION omni_memory_ids_have_deletion_barrier(TEXT, TEXT[])
FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_memory_has_deletion_receipt(TEXT, TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omni_memory_ids_have_deletion_barrier(TEXT, TEXT[])
TO PUBLIC;
GRANT EXECUTE ON FUNCTION omni_memory_has_deletion_receipt(TEXT, TEXT)
TO PUBLIC;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  58,
  'memory_deletion_barrier_policy_privilege_isolation',
  '5eb4483ee881615b4178d5ddc84949556a2ada088c8fd405e0d7b709aa67f870',
  NOW()
);
