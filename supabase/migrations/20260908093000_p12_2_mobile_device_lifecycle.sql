BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 144
      AND name = 'source_coverage_projection_v1'
      AND checksum = 'a40a9c1c20b2732a44219a9cb3eacf1291d6f7b9e12e8dce3d70e49a70d299db'
  ) <> 1 THEN
    RAISE EXCEPTION 'Mobile device lifecycle predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

LOCK TABLE omni_mobile_sessions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE omni_mobile_sessions
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
  ADD COLUMN IF NOT EXISTS wipe_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wipe_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wipe_challenge_hash TEXT,
  ADD COLUMN IF NOT EXISTS wipe_challenge_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by_session_id TEXT;

UPDATE omni_mobile_sessions
SET revocation_reason = 'legacy_revoked'
WHERE revoked_at IS NOT NULL
  AND revocation_reason IS NULL;

ALTER TABLE omni_mobile_sessions
  DROP CONSTRAINT IF EXISTS omni_mobile_sessions_lifecycle_check;

ALTER TABLE omni_mobile_sessions
  ADD CONSTRAINT omni_mobile_sessions_lifecycle_check CHECK (
    (revocation_reason IS NULL OR revocation_reason IN (
        'logout', 'refresh_reuse', 'password_changed', 'membership_changed',
        'user_revoked', 'remote_wipe', 'replaced', 'legacy_revoked'
      ))
    AND (
      (revoked_at IS NULL AND revocation_reason IS NULL)
      OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
    )
    AND (
      (revocation_reason = 'remote_wipe' AND wipe_requested_at IS NOT NULL)
      OR (revocation_reason IS DISTINCT FROM 'remote_wipe' AND wipe_requested_at IS NULL)
    )
    AND (wipe_acknowledged_at IS NULL OR wipe_requested_at IS NOT NULL)
    AND (
      (wipe_challenge_hash IS NULL AND wipe_challenge_expires_at IS NULL)
      OR (
        wipe_challenge_hash ~ '^[a-f0-9]{64}$'
        AND wipe_challenge_expires_at IS NOT NULL
        AND wipe_requested_at IS NOT NULL
        AND wipe_acknowledged_at IS NULL
      )
    )
    AND (
      (revocation_reason = 'replaced' AND replaced_by_session_id IS NOT NULL)
      OR (revocation_reason IS DISTINCT FROM 'replaced' AND replaced_by_session_id IS NULL)
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS omni_mobile_sessions_wipe_challenge_idx
  ON omni_mobile_sessions (wipe_challenge_hash)
  WHERE wipe_challenge_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS omni_mobile_sessions_actor_lifecycle_idx
  ON omni_mobile_sessions (
    tenant_id, user_id, COALESCE(last_seen_at, updated_at) DESC, id
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_mobile_sessions'::regclass
      AND conname = 'omni_mobile_sessions_lifecycle_check'
      AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'omni_mobile_sessions_wipe_challenge_idx'::regclass
      AND indisvalid
      AND indisready
  ) THEN
    RAISE EXCEPTION 'Mobile device lifecycle schema is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  145,
  'mobile_device_lifecycle_v1',
  '18fbfb5fdf45b3e83f49c07d5d2d7c698ebb62be16d3eb160bf7fd806871fb8f',
  clock_timestamp()
);

COMMIT;
