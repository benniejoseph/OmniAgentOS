BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 266 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 266 AND name = 'app_builder_verification_profiles_v1'
      AND checksum = '8ca15ecea9c2292360b110e3f484025a8021a64c1c61890237969b4b7175c313'
  ) <> 1 THEN
    RAISE EXCEPTION 'Assistant modes predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Add product modes to the durable prompt queue. Historical rows, sealed
-- prompts, immutable pins, RLS, ownership and lifecycle guards stay unchanged.
ALTER TABLE public.omni_prompt_queue_items
  DROP CONSTRAINT omni_prompt_queue_items_mode_check;
ALTER TABLE public.omni_prompt_queue_items
  ADD CONSTRAINT omni_prompt_queue_items_mode_check
  CHECK (mode IN ('orchestrate', 'research', 'execute', 'learn', 'chat', 'cowork', 'coding'));

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (267, 'assistant_modes_v1', '099127c8656f503bc51f677c471dbd499eaf1de68dedc4ab86facb043f2474c1', clock_timestamp());

COMMIT;
