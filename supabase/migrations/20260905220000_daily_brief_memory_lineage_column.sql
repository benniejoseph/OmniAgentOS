ALTER TABLE public.omni_daily_briefs
  ADD COLUMN IF NOT EXISTS memory_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE public.omni_daily_briefs brief
SET memory_ids = ARRAY(
  SELECT canonical.memory_id
  FROM (
    SELECT DISTINCT LEFT(BTRIM(item #>> '{}'), 200) AS memory_id
    FROM jsonb_array_elements(brief.content -> 'memoryIds') entry(item)
    WHERE jsonb_typeof(item) = 'string'
      AND NULLIF(LEFT(BTRIM(item #>> '{}'), 200), '') IS NOT NULL
  ) canonical
  ORDER BY canonical.memory_id COLLATE "C"
  LIMIT 12
)
WHERE cardinality(brief.memory_ids) = 0
  AND jsonb_typeof(brief.content -> 'memoryIds') = 'array';
UPDATE public.omni_daily_briefs brief
SET content = jsonb_set(
  brief.content,
  '{memoryIds}',
  to_jsonb(brief.memory_ids),
  TRUE
)
WHERE jsonb_typeof(brief.content) = 'object'
  AND (brief.content -> 'memoryIds') IS DISTINCT FROM to_jsonb(brief.memory_ids);
CREATE INDEX IF NOT EXISTS omni_daily_briefs_memory_ids_idx
  ON public.omni_daily_briefs USING GIN (memory_ids);
INSERT INTO public.omni_schema_version (version, name, checksum)
VALUES (
  74,
  'daily_brief_memory_lineage_column',
  'b0aeed374d527136094316d0b7ba0c48cd84a243dcbbd6b17235fcc512a564aa'
)
ON CONFLICT DO NOTHING;
