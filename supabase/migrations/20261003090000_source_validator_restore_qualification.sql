BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 212 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 212
      AND name = 'operation_job_quarantine_v1'
      AND checksum = '35fa5330f5f0577af4af9f95b5998954d7db829bff4e40c13e14a21461f67898'
  ) <> 1 THEN
    RAISE EXCEPTION 'Source validator restore qualification predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- SQL-language function bodies resolve their helper names at execution time.
-- pg_restore clears its search_path while copying rows, so these three v37
-- validators must name their public helpers explicitly. Keep their signatures,
-- IMMUTABLE behavior, NULL handling, owner and existing EXECUTE grants.
-- No function-wide search_path setting and no historical migration changes.
DO $functions$
DECLARE expected RECORD;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('public.omni_source_id_array_is_canonical(text[],integer)', 'boolean'),
      ('public.omni_jsonb_safe_integer_value(jsonb)', 'numeric'),
      ('public.omni_evidence_locator_v1_is_allowlisted(jsonb)', 'boolean')
    ) AS functions(signature, result_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc procedure
      JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = to_regprocedure(expected.signature)
        AND language.lanname = 'sql'
        AND procedure.prorettype = to_regtype(expected.result_type)
        AND procedure.provolatile = 'i'
        AND NOT procedure.prosecdef
        AND NOT procedure.proisstrict
        AND NOT procedure.proretset
        AND procedure.proconfig IS NULL
    ) THEN
      RAISE EXCEPTION 'Source validator % is missing or has unexpected attributes',
        expected.signature USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$functions$;

CREATE OR REPLACE FUNCTION public.omni_source_id_array_is_canonical(
  values_to_check TEXT[],
  maximum_entries INTEGER
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $function$
  SELECT values_to_check IS NOT NULL
    AND maximum_entries > 0
    AND cardinality(values_to_check) BETWEEN 1 AND maximum_entries
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT
          value,
          lag(value) OVER (ORDER BY ordinal_position) AS previous_value
        FROM unnest(values_to_check)
          WITH ORDINALITY AS entry(value, ordinal_position)
      ) ordered_values
      WHERE NOT public.omni_source_contract_id_is_valid(value)
        OR (
          previous_value IS NOT NULL
          AND value COLLATE "C" <= previous_value COLLATE "C"
        )
    )
$function$;

CREATE OR REPLACE FUNCTION public.omni_jsonb_safe_integer_value(
  value_to_check JSONB
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN public.omni_jsonb_safe_integer(value_to_check, 0)
      THEN (value_to_check #>> '{}')::NUMERIC
    ELSE NULL
  END
$function$;

CREATE OR REPLACE FUNCTION public.omni_evidence_locator_v1_is_allowlisted(
  locator_value JSONB
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(locator_value) <> 'object' THEN FALSE
    WHEN locator_value ->> 'kind' = 'text_span' THEN
      locator_value ?& ARRAY[
        'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
        'containerLength', 'containerSha256'
      ]
      AND locator_value - ARRAY[
        'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
        'containerLength', 'containerSha256'
      ] = '{}'::JSONB
      AND locator_value ->> 'offsetUnit' IN (
        'unicode_code_point', 'utf16_code_unit', 'utf8_byte'
      )
      AND public.omni_jsonb_safe_integer(locator_value -> 'startOffset', 0)
      AND public.omni_jsonb_safe_integer(locator_value -> 'endOffsetExclusive', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'containerLength', 1)
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endOffsetExclusive'
      ) > public.omni_jsonb_safe_integer_value(locator_value -> 'startOffset')
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endOffsetExclusive'
      ) <= public.omni_jsonb_safe_integer_value(locator_value -> 'containerLength')
      AND locator_value ->> 'containerSha256' ~ '^[0-9a-f]{64}$'
    WHEN locator_value ->> 'kind' = 'page' THEN
      locator_value ?& ARRAY['kind', 'pageNumber', 'pageCount']
      AND locator_value - ARRAY['kind', 'pageNumber', 'pageCount'] = '{}'::JSONB
      AND public.omni_jsonb_safe_integer(locator_value -> 'pageNumber', 1)
      AND (
        locator_value -> 'pageCount' = 'null'::JSONB
        OR (
          public.omni_jsonb_safe_integer(locator_value -> 'pageCount', 1)
          AND public.omni_jsonb_safe_integer_value(
            locator_value -> 'pageNumber'
          ) <= public.omni_jsonb_safe_integer_value(locator_value -> 'pageCount')
        )
      )
    WHEN locator_value ->> 'kind' = 'sheet_range' THEN
      locator_value ?& ARRAY[
        'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
        'startColumn', 'endColumnExclusive', 'sheetRowCount',
        'sheetColumnCount'
      ]
      AND locator_value - ARRAY[
        'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
        'startColumn', 'endColumnExclusive', 'sheetRowCount',
        'sheetColumnCount'
      ] = '{}'::JSONB
      AND locator_value ->> 'sheetKeySha256' ~ '^[0-9a-f]{64}$'
      AND public.omni_jsonb_safe_integer(locator_value -> 'startRow', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'endRowExclusive', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'startColumn', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'endColumnExclusive', 1)
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endRowExclusive'
      ) > public.omni_jsonb_safe_integer_value(locator_value -> 'startRow')
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endColumnExclusive'
      ) > public.omni_jsonb_safe_integer_value(locator_value -> 'startColumn')
      AND (
        locator_value -> 'sheetRowCount' = 'null'::JSONB
        OR (
          public.omni_jsonb_safe_integer(locator_value -> 'sheetRowCount', 1)
          AND public.omni_jsonb_safe_integer_value(
            locator_value -> 'endRowExclusive'
          ) <= public.omni_jsonb_safe_integer_value(
            locator_value -> 'sheetRowCount'
          ) + 1
        )
      )
      AND (
        locator_value -> 'sheetColumnCount' = 'null'::JSONB
        OR (
          public.omni_jsonb_safe_integer(locator_value -> 'sheetColumnCount', 1)
          AND public.omni_jsonb_safe_integer_value(
            locator_value -> 'endColumnExclusive'
          ) <= public.omni_jsonb_safe_integer_value(
            locator_value -> 'sheetColumnCount'
          ) + 1
        )
      )
    WHEN locator_value ->> 'kind' = 'slide' THEN
      locator_value ?& ARRAY[
        'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
      ]
      AND locator_value - ARRAY[
        'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
      ] = '{}'::JSONB
      AND public.omni_jsonb_safe_integer(locator_value -> 'slideNumber', 1)
      AND (
        locator_value -> 'slideCount' = 'null'::JSONB
        OR (
          public.omni_jsonb_safe_integer(locator_value -> 'slideCount', 1)
          AND public.omni_jsonb_safe_integer_value(
            locator_value -> 'slideNumber'
          ) <= public.omni_jsonb_safe_integer_value(locator_value -> 'slideCount')
        )
      )
      AND (
        locator_value -> 'elementKeySha256' = 'null'::JSONB
        OR locator_value ->> 'elementKeySha256' ~ '^[0-9a-f]{64}$'
      )
    WHEN locator_value ->> 'kind' = 'email_section' THEN
      locator_value ?& ARRAY[
        'kind', 'section', 'sectionIndex', 'partKeySha256'
      ]
      AND locator_value - ARRAY[
        'kind', 'section', 'sectionIndex', 'partKeySha256'
      ] = '{}'::JSONB
      AND locator_value ->> 'section' IN (
        'headers', 'subject', 'body', 'attachment'
      )
      AND public.omni_jsonb_safe_integer(locator_value -> 'sectionIndex', 0)
      AND (
        locator_value -> 'partKeySha256' = 'null'::JSONB
        OR locator_value ->> 'partKeySha256' ~ '^[0-9a-f]{64}$'
      )
    WHEN locator_value ->> 'kind' = 'image_region' THEN
      locator_value ?& ARRAY[
        'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
        'imageWidth', 'imageHeight'
      ]
      AND locator_value - ARRAY[
        'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
        'imageWidth', 'imageHeight'
      ] = '{}'::JSONB
      AND locator_value ->> 'coordinateUnit' = 'pixel'
      AND public.omni_jsonb_safe_integer(locator_value -> 'x', 0)
      AND public.omni_jsonb_safe_integer(locator_value -> 'y', 0)
      AND public.omni_jsonb_safe_integer(locator_value -> 'width', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'height', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'imageWidth', 1)
      AND public.omni_jsonb_safe_integer(locator_value -> 'imageHeight', 1)
      AND public.omni_jsonb_safe_integer_value(locator_value -> 'x')
        + public.omni_jsonb_safe_integer_value(locator_value -> 'width')
        <= public.omni_jsonb_safe_integer_value(locator_value -> 'imageWidth')
      AND public.omni_jsonb_safe_integer_value(locator_value -> 'y')
        + public.omni_jsonb_safe_integer_value(locator_value -> 'height')
        <= public.omni_jsonb_safe_integer_value(locator_value -> 'imageHeight')
    WHEN locator_value ->> 'kind' = 'media_time_range' THEN
      locator_value ?& ARRAY[
        'kind', 'mediaKind', 'startMilliseconds',
        'endMillisecondsExclusive', 'durationMilliseconds'
      ]
      AND locator_value - ARRAY[
        'kind', 'mediaKind', 'startMilliseconds',
        'endMillisecondsExclusive', 'durationMilliseconds'
      ] = '{}'::JSONB
      AND locator_value ->> 'mediaKind' IN ('audio', 'video')
      AND public.omni_jsonb_safe_integer(
        locator_value -> 'startMilliseconds',
        0
      )
      AND public.omni_jsonb_safe_integer(
        locator_value -> 'endMillisecondsExclusive',
        1
      )
      AND public.omni_jsonb_safe_integer(
        locator_value -> 'durationMilliseconds',
        1
      )
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endMillisecondsExclusive'
      ) > public.omni_jsonb_safe_integer_value(
        locator_value -> 'startMilliseconds'
      )
      AND public.omni_jsonb_safe_integer_value(
        locator_value -> 'endMillisecondsExclusive'
      ) <= public.omni_jsonb_safe_integer_value(
        locator_value -> 'durationMilliseconds'
      )
    ELSE FALSE
  END
$function$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  213,
  'source_validator_restore_qualification_v1',
  '0540f57f5a92f5dd02b2d3289537a3bd26104f2c945f4280464bf06c084c3a65',
  clock_timestamp()
);

COMMIT;
