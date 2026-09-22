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

  IF latest_version IS DISTINCT FROM 199 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 199
      AND name = 'scheduled_workflow_policy_lease_v1'
      AND checksum = '56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093'
  ) <> 1 THEN
    RAISE EXCEPTION 'Notification disposition runtime predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Durable proactive notification policy records content-free dispositions.
-- Canonical domain tables retain all titles, messages, errors, and model text.
ALTER TABLE public.omni_mobile_push_deliveries
  DROP CONSTRAINT IF EXISTS omni_mobile_push_deliveries_cause_kind_check_v2;
ALTER TABLE public.omni_mobile_push_deliveries
  ADD CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v3 CHECK (
    cause_kind COLLATE "C" IN (
      'approval', 'work_item', 'meeting', 'customer', 'run',
      'notification', 'canary'
    )
  ) NOT VALID;
ALTER TABLE public.omni_mobile_push_deliveries
  VALIDATE CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v3;

CREATE TABLE public.omni_notification_digest_deliveries (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  sequence_number BIGINT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  candidate_count SMALLINT NOT NULL,
  candidate_manifest_sha256 TEXT NOT NULL,
  delivery_binding_sha256 TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  content_included BOOLEAN NOT NULL DEFAULT FALSE,
  decision_grants_authority BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  UNIQUE (tenant_id, owner_actor_id, sequence_number),
  CHECK (schema_version = 1),
  CHECK (id ~ '^notification_digest_[a-f0-9]{48}$'),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
  CHECK (window_started_at <= window_ended_at),
  CHECK (window_ended_at <= recorded_at),
  CHECK (candidate_count BETWEEN 1 AND 100),
  CHECK (candidate_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (delivery_binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (NOT content_included),
  CHECK (NOT decision_grants_authority),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.omni_notification_dispositions (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  occurrence_sha256 TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  must_send BOOLEAN NOT NULL,
  critical BOOLEAN NOT NULL,
  policy_sha256 TEXT NOT NULL,
  decision_receipt_sha256 TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ,
  digest_delivery_id TEXT,
  delivery_kind TEXT,
  delivery_binding_sha256 TEXT,
  lifecycle_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  content_included BOOLEAN NOT NULL DEFAULT FALSE,
  decision_grants_authority BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (tenant_id, owner_actor_id, id),
  UNIQUE (tenant_id, owner_actor_id, candidate_sha256),
  UNIQUE (
    tenant_id, owner_actor_id, source_kind, source_id, occurrence_key
  ),
  CHECK (schema_version = 1),
  CHECK (id ~ '^notification_disposition_[a-f0-9]{48}$'),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (source_kind IN (
    'tool_approval', 'meeting', 'customer_risk', 'agent_run',
    'today_reminder', 'delegated_task', 'scheduled_routine',
    'security_incident'
  )),
  CHECK (char_length(source_id) BETWEEN 1 AND 240),
  CHECK (char_length(occurrence_key) BETWEEN 1 AND 1000),
  CHECK (occurrence_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (outcome IN ('send', 'defer', 'digest', 'suppress')),
  CHECK (state IN ('pending', 'terminal')),
  CHECK (reason IN (
    'approval_required', 'security_alert', 'actionable_failure',
    'meeting_imminent', 'critical_delivery', 'quiet_hours',
    'cooldown_active', 'digest_nonurgent', 'digest_during_cooldown',
    'routine_success', 'failure_not_actionable',
    'meeting_not_imminent', 'not_worthy'
  )),
  CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (decision_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (
    (outcome = 'defer' AND state = 'pending' AND due_at IS NOT NULL
      AND due_at > evaluated_at
      AND due_at <= evaluated_at + INTERVAL '24 hours')
    OR (outcome = 'send' AND state = 'pending' AND due_at IS NOT NULL
      AND due_at > evaluated_at
      AND due_at <= evaluated_at + INTERVAL '24 hours')
    OR (outcome <> 'defer' AND NOT (outcome = 'send' AND state = 'pending')
      AND due_at IS NULL)
  ),
  CHECK (
    (outcome = 'send' AND (
      (state = 'pending' AND delivery_kind IS NULL
        AND delivery_binding_sha256 IS NULL)
      OR
      (state = 'terminal' AND delivery_kind IS NOT NULL
        AND delivery_binding_sha256 IS NOT NULL)
    ))
    OR outcome <> 'send'
  ),
  CHECK (
    (outcome = 'suppress' AND state = 'terminal'
      AND delivery_kind IS NULL
      AND delivery_binding_sha256 IS NULL)
    OR outcome <> 'suppress'
  ),
  CHECK (
    (outcome = 'digest' AND (
      (state = 'pending' AND digest_delivery_id IS NULL
        AND delivery_kind IS NULL AND delivery_binding_sha256 IS NULL)
      OR
      (state = 'terminal' AND digest_delivery_id IS NOT NULL
        AND delivery_kind = 'digest_ledger'
        AND delivery_binding_sha256 IS NOT NULL)
    ))
    OR outcome <> 'digest'
  ),
  CHECK (
    outcome IN ('send', 'digest')
    OR (delivery_kind IS NULL AND delivery_binding_sha256 IS NULL)
  ),
  CHECK (delivery_kind IS NULL OR delivery_kind IN (
    'mobile_push_outbox', 'incident_alert_outbox',
    'notification_ledger', 'digest_ledger'
  )),
  CHECK (delivery_binding_sha256 IS NULL OR delivery_binding_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (lifecycle_revision BETWEEN 0 AND 9007199254740991),
  CHECK (created_at <= updated_at),
  CHECK ((state = 'terminal') = (terminal_at IS NOT NULL)),
  CHECK (terminal_at IS NULL OR terminal_at >= created_at),
  CHECK (NOT content_included),
  CHECK (NOT decision_grants_authority),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, digest_delivery_id)
    REFERENCES public.omni_notification_digest_deliveries(
      tenant_id, owner_actor_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.omni_notification_digest_watermarks (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  sequence_number BIGINT NOT NULL DEFAULT 0,
  last_window_ended_at TIMESTAMPTZ,
  last_delivery_id TEXT,
  last_candidate_manifest_sha256 TEXT,
  lifecycle_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id),
  CHECK (schema_version = 1),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (sequence_number BETWEEN 0 AND 9007199254740991),
  CHECK (
    (sequence_number = 0 AND last_window_ended_at IS NULL
      AND last_delivery_id IS NULL
      AND last_candidate_manifest_sha256 IS NULL)
    OR
    (sequence_number > 0 AND last_window_ended_at IS NOT NULL
      AND last_delivery_id IS NOT NULL
      AND last_candidate_manifest_sha256 ~ '^[a-f0-9]{64}$')
  ),
  CHECK (lifecycle_revision = sequence_number),
  CHECK (created_at <= updated_at),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users(actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, last_delivery_id)
    REFERENCES public.omni_notification_digest_deliveries(
      tenant_id, owner_actor_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_notification_dispositions_due_idx
ON public.omni_notification_dispositions (
  tenant_id, owner_actor_id, due_at, id
)
WHERE outcome = 'defer' AND state = 'pending';

CREATE INDEX omni_notification_dispositions_digest_idx
ON public.omni_notification_dispositions (
  tenant_id, owner_actor_id, evaluated_at, id
)
WHERE outcome = 'digest' AND state = 'pending';

CREATE INDEX omni_notification_dispositions_source_idx
ON public.omni_notification_dispositions (
  tenant_id, owner_actor_id, source_kind, source_id, occurrence_key
);

CREATE INDEX omni_notification_digest_deliveries_actor_idx
ON public.omni_notification_digest_deliveries (
  tenant_id, owner_actor_id, recorded_at DESC, id
);

CREATE OR REPLACE FUNCTION public.omni_protect_notification_disposition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Notification dispositions cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_revision <> 0
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'Initial notification disposition is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.schema_version, NEW.id, NEW.tenant_id, NEW.owner_actor_id,
    NEW.source_kind, NEW.source_id, NEW.occurrence_key,
    NEW.occurrence_sha256, NEW.candidate_sha256, NEW.created_at,
    NEW.content_included, NEW.decision_grants_authority
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.id, OLD.tenant_id, OLD.owner_actor_id,
    OLD.source_kind, OLD.source_id, OLD.occurrence_key,
    OLD.occurrence_sha256, OLD.candidate_sha256, OLD.created_at,
    OLD.content_included, OLD.decision_grants_authority
  ) OR OLD.state <> 'pending'
    OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Notification disposition identity or revision is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome IN ('defer', 'send') THEN
    IF NEW.updated_at < OLD.due_at THEN
      RAISE EXCEPTION 'Retryable notification cannot be reconsidered before it is due'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.outcome = 'digest' THEN
    IF NEW.outcome <> 'digest' OR NEW.state <> 'terminal' THEN
      RAISE EXCEPTION 'Digest notification may only bind its digest delivery'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Terminal notification disposition cannot change'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_reject_notification_digest_change_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Notification digest deliveries are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_notification_digest_watermark_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Notification digest watermarks cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.sequence_number <> 0 OR NEW.lifecycle_revision <> 0
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'Initial notification digest watermark is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.schema_version <> OLD.schema_version
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.owner_actor_id <> OLD.owner_actor_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.sequence_number <> OLD.sequence_number + 1
    OR NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.last_window_ended_at IS NOT NULL
      AND NEW.last_window_ended_at < OLD.last_window_ended_at)
  THEN
    RAISE EXCEPTION 'Notification digest watermark transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_notification_dispositions_protect
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_notification_dispositions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_notification_disposition_v1();
CREATE TRIGGER omni_notification_dispositions_no_truncate
BEFORE TRUNCATE ON public.omni_notification_dispositions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_notification_disposition_v1();
CREATE TRIGGER omni_notification_digest_deliveries_immutable
BEFORE UPDATE OR DELETE ON public.omni_notification_digest_deliveries
FOR EACH ROW EXECUTE FUNCTION public.omni_reject_notification_digest_change_v1();
CREATE TRIGGER omni_notification_digest_deliveries_no_truncate
BEFORE TRUNCATE ON public.omni_notification_digest_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_reject_notification_digest_change_v1();
CREATE TRIGGER omni_notification_digest_watermarks_protect
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_notification_digest_watermarks
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_notification_digest_watermark_v1();
CREATE TRIGGER omni_notification_digest_watermarks_no_truncate
BEFORE TRUNCATE ON public.omni_notification_digest_watermarks
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_notification_digest_watermark_v1();

ALTER TABLE public.omni_notification_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_notification_dispositions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_notification_digest_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_notification_digest_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_notification_digest_watermarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_notification_digest_watermarks FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_notification_dispositions AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_notification_dispositions_actor
ON public.omni_notification_dispositions AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

CREATE POLICY omni_tenant_isolation
ON public.omni_notification_digest_deliveries AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_notification_digest_deliveries_actor
ON public.omni_notification_digest_deliveries AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

CREATE POLICY omni_tenant_isolation
ON public.omni_notification_digest_watermarks AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_notification_digest_watermarks_actor
ON public.omni_notification_digest_watermarks AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON public.omni_notification_dispositions FROM PUBLIC;
REVOKE ALL ON public.omni_notification_digest_deliveries FROM PUBLIC;
REVOKE ALL ON public.omni_notification_digest_watermarks FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_notification_disposition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_reject_notification_digest_change_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_notification_digest_watermark_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_dispositions FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_digest_deliveries FROM omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_digest_watermarks FROM omni_runtime';
    GRANT SELECT, INSERT ON public.omni_notification_dispositions TO omni_runtime;
    GRANT UPDATE (
      outcome, state, reason, must_send, critical, policy_sha256,
      decision_receipt_sha256, evaluated_at, due_at, digest_delivery_id,
      delivery_kind, delivery_binding_sha256, lifecycle_revision,
      updated_at, terminal_at
    ) ON public.omni_notification_dispositions TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_notification_digest_deliveries TO omni_runtime;
    GRANT SELECT, INSERT ON public.omni_notification_digest_watermarks TO omni_runtime;
    GRANT UPDATE (
      sequence_number, last_window_ended_at, last_delivery_id,
      last_candidate_manifest_sha256, lifecycle_revision, updated_at
    ) ON public.omni_notification_digest_watermarks TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_dispositions FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_digest_deliveries FROM omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_notification_digest_watermarks FROM omni_maintenance';
    GRANT SELECT, INSERT ON public.omni_notification_dispositions TO omni_maintenance;
    GRANT UPDATE (
      outcome, state, reason, must_send, critical, policy_sha256,
      decision_receipt_sha256, evaluated_at, due_at, digest_delivery_id,
      delivery_kind, delivery_binding_sha256, lifecycle_revision,
      updated_at, terminal_at
    ) ON public.omni_notification_dispositions TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_notification_digest_deliveries TO omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_notification_digest_watermarks TO omni_maintenance;
    GRANT UPDATE (
      sequence_number, last_window_ended_at, last_delivery_id,
      last_candidate_manifest_sha256, lifecycle_revision, updated_at
    ) ON public.omni_notification_digest_watermarks TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_notification_dispositions TO omni_backup;
    GRANT SELECT ON public.omni_notification_digest_deliveries TO omni_backup;
    GRANT SELECT ON public.omni_notification_digest_watermarks TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM pg_class relation
    WHERE relation.oid IN (
      'public.omni_notification_dispositions'::regclass,
      'public.omni_notification_digest_deliveries'::regclass,
      'public.omni_notification_digest_watermarks'::regclass
    ) AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 3 OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid IN (
      'public.omni_notification_dispositions'::regclass,
      'public.omni_notification_digest_deliveries'::regclass,
      'public.omni_notification_digest_watermarks'::regclass
    ) AND NOT polpermissive AND polcmd = '*'
  ) <> 3 OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'omni_notification_dispositions',
        'omni_notification_digest_deliveries',
        'omni_notification_digest_watermarks'
      )
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('DELETE', 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'omni_notification_digest_deliveries'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type = 'UPDATE'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_mobile_push_deliveries'::regclass
      AND conname = 'omni_mobile_push_deliveries_cause_kind_check_v3'
      AND contype = 'c'
      AND position(
        'notification' IN lower(pg_get_constraintdef(oid, TRUE))
      ) > 0
  ) THEN
    RAISE EXCEPTION 'Notification disposition runtime boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  200,
  'notification_disposition_runtime_v1',
  '99af5ab52a824c435e19e46f918755bfa549a1fecda22f9061940f9030c97c2b',
  clock_timestamp()
);

COMMIT;
