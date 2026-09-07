DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM omni_retrieval_traces trace
    WHERE NOT omni_direct_trace_memory_ids(trace.results)
      <@ trace.memory_ids
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'omni_retrieval_traces'::regclass
      AND attribute.attname = 'memory_ids'
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_index index_value
    JOIN pg_class index_relation
      ON index_relation.oid = index_value.indexrelid
    WHERE index_value.indrelid = 'omni_retrieval_traces'::regclass
      AND index_relation.relname = 'omni_retrieval_traces_memory_ids_idx'
      AND index_value.indisvalid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'omni_retrieval_traces'::regclass
      AND tgname = 'omni_retrieval_traces_memory_lineage'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'Retrieval trace lineage is not ready for indexed-only lookup'
      USING ERRCODE = '23514';
  END IF;
END
$migration$;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  78,
  'retrieval_trace_lineage_query_cutover',
  '294a7328f6a0d68d82496975b3827d5c53a91ac7a1215b2a829c8a64290c9ca2',
  NOW()
);
