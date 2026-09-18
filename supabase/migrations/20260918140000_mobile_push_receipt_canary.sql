BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 184 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 184
      AND name = 'semantic_decision_shadow_pilot_v1'
      AND checksum = '142047c12f42ba8135d7bfd95edde467ebcedf4d42f5c69937b4fe797a865223'
  ) <> 1 THEN
    RAISE EXCEPTION 'Mobile push receipt canary predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_mobile_push_deliveries
  ADD COLUMN IF NOT EXISTS provider_accepted_at TIMESTAMPTZ;
ALTER TABLE public.omni_mobile_push_registrations
  ADD COLUMN IF NOT EXISTS last_provider_accepted_at TIMESTAMPTZ;

UPDATE public.omni_mobile_push_deliveries
SET provider_accepted_at = delivered_at
WHERE provider_accepted_at IS NULL
  AND delivered_at IS NOT NULL;
UPDATE public.omni_mobile_push_registrations
SET last_provider_accepted_at = last_delivered_at
WHERE last_provider_accepted_at IS NULL
  AND last_delivered_at IS NOT NULL;

DO $migration$
DECLARE
  constraint_record RECORD;
  cause_kind_attribute SMALLINT;
BEGIN
  SELECT attnum INTO STRICT cause_kind_attribute
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.omni_mobile_push_deliveries'::regclass
    AND attname = 'cause_kind'
    AND NOT attisdropped;

  ALTER TABLE public.omni_mobile_push_deliveries
    DROP CONSTRAINT IF EXISTS omni_mobile_push_deliveries_cause_kind_check_v2;
  FOR constraint_record IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid =
        'public.omni_mobile_push_deliveries'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey = ARRAY[cause_kind_attribute]::SMALLINT[]
      AND position(
        'approval' IN lower(pg_get_constraintdef(constraint_row.oid, TRUE))
      ) > 0
      AND position(
        'work_item' IN lower(pg_get_constraintdef(constraint_row.oid, TRUE))
      ) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE public.omni_mobile_push_deliveries DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;
END
$migration$;

ALTER TABLE public.omni_mobile_push_deliveries
  ADD CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v2
  CHECK (
    cause_kind COLLATE "C" IN (
      'approval', 'work_item', 'meeting', 'customer', 'run', 'canary'
    )
  ) NOT VALID;
ALTER TABLE public.omni_mobile_push_deliveries
  VALIDATE CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v2;

ALTER TABLE public.omni_mobile_push_deliveries
  DROP CONSTRAINT IF EXISTS omni_mobile_push_provider_accepted_at_check;
ALTER TABLE public.omni_mobile_push_deliveries
  ADD CONSTRAINT omni_mobile_push_provider_accepted_at_check CHECK (
    (provider_accepted_at IS NOT NULL) =
      (status COLLATE "C" IN ('delivered', 'acknowledged'))
  ) NOT VALID;
ALTER TABLE public.omni_mobile_push_deliveries
  VALIDATE CONSTRAINT omni_mobile_push_provider_accepted_at_check;

CREATE UNIQUE INDEX IF NOT EXISTS omni_mobile_push_delivery_receipt_parent_idx
  ON public.omni_mobile_push_deliveries (
    tenant_id, owner_actor_id, id, registration_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS omni_mobile_push_canary_idempotency_idx
  ON public.omni_mobile_push_deliveries (
    tenant_id, owner_actor_id, cause_id
  ) WHERE cause_kind = 'canary';

CREATE TABLE IF NOT EXISTS public.omni_mobile_push_delivery_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  mobile_session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  receipt_kind TEXT NOT NULL,
  action TEXT,
  app_lifecycle TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, owner_actor_id, delivery_id, registration_id)
    REFERENCES public.omni_mobile_push_deliveries (
      tenant_id, owner_actor_id, id, registration_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, registration_id)
    REFERENCES public.omni_mobile_push_registrations (
      tenant_id, owner_actor_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (
    tenant_id, owner_actor_id, delivery_id, idempotency_key_sha256
  ),
  CHECK (char_length(id) BETWEEN 16 AND 200),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 500),
  CHECK (char_length(device_id) BETWEEN 8 AND 200),
  CHECK (platform COLLATE "C" IN ('android', 'ios', 'macos')),
  CHECK (receipt_kind COLLATE "C" IN ('received', 'opened', 'action')),
  CHECK (action IS NULL OR action COLLATE "C" IN (
    'open', 'complete', 'snooze', 'dismiss'
  )),
  CHECK ((receipt_kind = 'action') = (action IS NOT NULL)),
  CHECK (app_lifecycle COLLATE "C" IN (
    'foreground', 'background', 'terminated', 'unknown'
  )),
  CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS omni_mobile_push_receipt_delivery_idx
  ON public.omni_mobile_push_delivery_receipts (
    tenant_id, owner_actor_id, delivery_id, recorded_at, id
  );
CREATE INDEX IF NOT EXISTS omni_mobile_push_receipt_registration_idx
  ON public.omni_mobile_push_delivery_receipts (
    tenant_id, registration_id, recorded_at DESC
  );

CREATE OR REPLACE FUNCTION public.omni_reject_mobile_push_receipt_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Mobile push delivery receipts are immutable'
    USING ERRCODE = '55000';
END
$function$;
DROP TRIGGER IF EXISTS omni_mobile_push_delivery_receipts_immutable
  ON public.omni_mobile_push_delivery_receipts;
CREATE TRIGGER omni_mobile_push_delivery_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.omni_mobile_push_delivery_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.omni_reject_mobile_push_receipt_mutation_v1();
DROP TRIGGER IF EXISTS omni_mobile_push_delivery_receipts_no_truncate
  ON public.omni_mobile_push_delivery_receipts;
CREATE TRIGGER omni_mobile_push_delivery_receipts_no_truncate
  BEFORE TRUNCATE ON public.omni_mobile_push_delivery_receipts
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.omni_reject_mobile_push_receipt_mutation_v1();
REVOKE ALL ON FUNCTION public.omni_reject_mobile_push_receipt_mutation_v1()
  FROM PUBLIC;

ALTER TABLE public.omni_mobile_push_delivery_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_mobile_push_delivery_receipts
  FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS omni_tenant_isolation
  ON public.omni_mobile_push_delivery_receipts;
DROP POLICY IF EXISTS omni_mobile_push_delivery_receipts_actor
  ON public.omni_mobile_push_delivery_receipts;
CREATE POLICY omni_tenant_isolation
  ON public.omni_mobile_push_delivery_receipts
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (public.omni_tenant_visible(tenant_id))
  WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_mobile_push_delivery_receipts_actor
  ON public.omni_mobile_push_delivery_receipts
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    public.omni_system_scope_enabled()
    OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  )
  WITH CHECK (
    public.omni_system_scope_enabled()
    OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  );

REVOKE ALL ON TABLE public.omni_mobile_push_delivery_receipts FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON public.omni_mobile_push_delivery_receipts
      TO omni_runtime;
    GRANT UPDATE (provider_accepted_at)
      ON public.omni_mobile_push_deliveries TO omni_runtime;
    GRANT UPDATE (last_provider_accepted_at)
      ON public.omni_mobile_push_registrations TO omni_runtime;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'omni_maintenance'
  ) THEN
    GRANT SELECT, INSERT ON public.omni_mobile_push_delivery_receipts
      TO omni_maintenance;
    GRANT UPDATE (provider_accepted_at)
      ON public.omni_mobile_push_deliveries TO omni_maintenance;
    GRANT UPDATE (last_provider_accepted_at)
      ON public.omni_mobile_push_registrations TO omni_maintenance;
  END IF;
END
$migration$;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.omni_mobile_push_delivery_receipts'::regclass
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.omni_mobile_push_delivery_receipts'::regclass
  ) <> 2 OR (
    SELECT count(*) FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.omni_mobile_push_delivery_receipts'::regclass
      AND polname = 'omni_mobile_push_delivery_receipts_actor'
      AND NOT polpermissive
      AND polcmd = '*'
      AND polroles = ARRAY[0::OID]
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.omni_mobile_push_deliveries'::regclass
      AND conname = 'omni_mobile_push_deliveries_cause_kind_check_v2'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.omni_mobile_push_deliveries'::regclass
      AND conname = 'omni_mobile_push_provider_accepted_at_check'
      AND convalidated
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.omni_mobile_push_delivery_receipts'::regclass
      AND NOT tgisinternal
      AND tgname IN (
        'omni_mobile_push_delivery_receipts_immutable',
        'omni_mobile_push_delivery_receipts_no_truncate'
      )
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid =
        'public.omni_mobile_push_canary_idempotency_idx'::regclass
      AND indisunique AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Mobile push receipt boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  185,
  'mobile_push_receipt_canary_v1',
  'a4840325f34b054c01c953bc8253a2123df4cc0d87369ce386ac69a6c8b11f03',
  clock_timestamp()
);

COMMIT;
