BEGIN;

DO $migration$
BEGIN
  IF (SELECT max(version) FROM omni_schema_version) IS DISTINCT FROM 255
    OR (SELECT count(*) FROM omni_schema_version WHERE version = 255
      AND name = 'responsibility_workspace_fence_acl_repair_v1'
      AND checksum = '279d151896f8c954d79becfb79966a1af04d43d23fec55eddc765bb0f4cf49d5') <> 1
  THEN RAISE EXCEPTION 'Project task commitments predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Nullable additions preserve every existing task and its canonical hash.
-- A named person is descriptive metadata; actor ownership and grants do not change.
ALTER TABLE public.omni_project_tasks
  ADD COLUMN human_owner TEXT,
  ADD COLUMN due_date DATE,
  ADD COLUMN due_time_zone TEXT,
  ADD CONSTRAINT omni_project_tasks_human_owner_check CHECK (
    human_owner IS NULL OR (human_owner = btrim(human_owner) AND char_length(human_owner) BETWEEN 1 AND 160)
  ),
  ADD CONSTRAINT omni_project_tasks_due_date_check CHECK (
    due_date IS NULL OR (due_at IS NULL AND due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
  ),
  ADD CONSTRAINT omni_project_tasks_due_time_zone_check CHECK (
    due_time_zone IS NULL OR (due_date IS NOT NULL AND due_time_zone = btrim(due_time_zone) AND char_length(due_time_zone) BETWEEN 1 AND 80)
  );

DO $migration$
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.omni_project_tasks'::regclass
    AND attname IN ('human_owner', 'due_date', 'due_time_zone') AND NOT attnotnull AND NOT attisdropped) <> 3
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.omni_project_tasks'::regclass
      AND conname IN ('omni_project_tasks_human_owner_check', 'omni_project_tasks_due_date_check', 'omni_project_tasks_due_time_zone_check') AND convalidated) <> 3
  THEN RAISE EXCEPTION 'Project task commitment fields are incomplete' USING ERRCODE = '55000'; END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (256, 'project_task_commitments_v1', '7f5e16f8893f8d619879d7b44880788d8e9ba42438c5f2e042b43c1b87a3c832', clock_timestamp());

COMMIT;
