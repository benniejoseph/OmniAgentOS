BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 203
      AND name = 'agent_daily_learning_v1'
      AND checksum = '88fa0dd240ba1920d2bb66395bb2b268dc98bd682282fbe3633d1df4b1d01f96'
  ) <> 1 THEN
    RAISE EXCEPTION 'Google multi-account connection predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Google connector accounts are explicit, owner-scoped, and independently selectable.
ALTER TABLE public.omni_oauth_grants
  ADD COLUMN IF NOT EXISTS account_email TEXT,
  ADD COLUMN IF NOT EXISTS connection_label TEXT NOT NULL DEFAULT 'Personal',
  ADD COLUMN IF NOT EXISTS connection_purpose TEXT NOT NULL DEFAULT 'personal';

UPDATE public.omni_oauth_grants
SET connection_label = 'Personal',
    connection_purpose = 'personal'
WHERE connection_label IS NULL
   OR btrim(connection_label) = ''
   OR connection_purpose IS NULL
   OR btrim(connection_purpose) = '';

ALTER TABLE public.omni_oauth_grants
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_tenant_id_actor_id_provider_key,
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_connection_label_check,
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_connection_purpose_check,
  DROP CONSTRAINT IF EXISTS omni_oauth_grants_account_email_check;

ALTER TABLE public.omni_oauth_grants
  ADD CONSTRAINT omni_oauth_grants_connection_label_check
    CHECK (
      char_length(connection_label) BETWEEN 1 AND 80
      AND connection_label = btrim(connection_label)
    ),
  ADD CONSTRAINT omni_oauth_grants_connection_purpose_check
    CHECK (connection_purpose IN ('personal', 'work')),
  ADD CONSTRAINT omni_oauth_grants_account_email_check
    CHECK (
      account_email IS NULL
      OR (
        account_email = lower(btrim(account_email))
        AND char_length(account_email) BETWEEN 3 AND 320
        AND account_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS omni_oauth_grants_actor_provider_purpose_key
  ON public.omni_oauth_grants (
    tenant_id,
    actor_id,
    provider,
    connection_purpose
  );

CREATE UNIQUE INDEX IF NOT EXISTS omni_oauth_grants_actor_provider_email_key
  ON public.omni_oauth_grants (
    tenant_id,
    actor_id,
    provider,
    account_email
  )
  WHERE account_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS omni_oauth_grants_connection_lookup_idx
  ON public.omni_oauth_grants (
    tenant_id,
    actor_id,
    provider,
    id,
    status
  );

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.omni_oauth_grants
    WHERE provider = 'google'
      AND status = 'active'
      AND account_email IS NOT NULL
      AND connection_purpose NOT IN ('personal', 'work')
  ) THEN
    RAISE EXCEPTION 'Google OAuth connection purpose backfill is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  204,
  'google_multi_account_connections_v1',
  '8c7ae456bdbcc92f00adb2f24728cf03dc2b082cae7880e0f87ce71d15314cd8',
  clock_timestamp()
);

COMMIT;
