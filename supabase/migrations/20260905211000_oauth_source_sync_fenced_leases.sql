SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
ALTER TABLE omni_oauth_grants
  ADD COLUMN IF NOT EXISTS sync_lease_owner_id TEXT;
ALTER TABLE omni_oauth_grants
  ADD COLUMN IF NOT EXISTS sync_lease_expires_at TIMESTAMPTZ;
ALTER TABLE omni_oauth_grants
  ADD COLUMN IF NOT EXISTS sync_lease_generation INTEGER NOT NULL DEFAULT 0;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omni_oauth_grants_sync_lease_pair_check'
  ) THEN
    ALTER TABLE omni_oauth_grants
      ADD CONSTRAINT omni_oauth_grants_sync_lease_pair_check CHECK (
        (sync_lease_owner_id IS NULL AND sync_lease_expires_at IS NULL)
        OR
        (sync_lease_owner_id IS NOT NULL AND sync_lease_expires_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omni_oauth_grants_sync_lease_generation_check'
  ) THEN
    ALTER TABLE omni_oauth_grants
      ADD CONSTRAINT omni_oauth_grants_sync_lease_generation_check CHECK (
        sync_lease_generation >= 0
      );
  END IF;
END
$migration$;
CREATE INDEX IF NOT EXISTS omni_oauth_grants_sync_lease_idx
  ON omni_oauth_grants (
    tenant_id,
    actor_id,
    provider,
    sync_lease_expires_at
  )
  WHERE sync_lease_owner_id IS NOT NULL;
INSERT INTO omni_schema_version (version, name, checksum, applied_at)
SELECT
  71,
  'oauth_source_sync_fenced_leases',
  '1d128700ad7a4b01f0ba7a4e78521a778ff7e49da52e820f87e973f30ea9ce15',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM omni_schema_version WHERE version = 71
);
