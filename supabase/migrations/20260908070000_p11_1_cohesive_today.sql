BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 141
      AND name = 'customer_success_workflows_v1'
      AND checksum = '6ed4f5625107af151e49cf1fe094b9637af2053f5f1c85e31f6984cc1b4e7f38'
  ) <> 1 THEN
    RAISE EXCEPTION 'Cohesive Today predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_today_preferences
  ADD COLUMN visible_sections TEXT[] NOT NULL DEFAULT ARRAY[
    'focus', 'agenda', 'approvals', 'customers', 'active_agents',
    'work', 'memory', 'conversations', 'consumption'
  ]::TEXT[];

ALTER TABLE omni_today_preferences
  ADD CONSTRAINT omni_today_preferences_visible_sections_valid CHECK (
    cardinality(visible_sections) BETWEEN 1 AND 9
    AND visible_sections <@ ARRAY[
      'focus', 'agenda', 'approvals', 'customers', 'active_agents',
      'work', 'memory', 'conversations', 'consumption'
    ]::TEXT[]
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'omni_today_preferences'
      AND column_name = 'visible_sections'
      AND data_type = 'ARRAY'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_today_preferences'::regclass
      AND conname = 'omni_today_preferences_visible_sections_valid'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Cohesive Today preference schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  142,
  'cohesive_today_preferences_v1',
  'c2ccb45d121194793876b68fec90c68f2d1bdfadcc889aebdd5abd9f4bd8763d',
  clock_timestamp()
);

COMMIT;
