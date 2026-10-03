BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 215 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 215
      AND name = 'companion_preferences_v1'
      AND checksum = 'e24b96868f0833a36f887f8fa57885d9a35fb002e25495f4fdafd1424b82d373'
  ) <> 1 THEN
    RAISE EXCEPTION 'Responsibility drafts predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- A reviewed draft is non-activating evidence. These tables have no scheduler,
-- delivery, run, approval or PolicyLease foreign keys and create no work.
CREATE TABLE public.omni_responsibilities (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 320),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('draft', 'reviewed')),
  draft_sha256 TEXT NOT NULL CHECK (draft_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 65536),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, id),
  CHECK (created_at <= updated_at)
);
CREATE INDEX omni_responsibilities_owner_recent ON public.omni_responsibilities (tenant_id, actor_id, updated_at DESC, id);

CREATE TABLE public.omni_responsibility_mutations (
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  id TEXT NOT NULL UNIQUE CHECK (id ~ '^responsibility-mutation:[a-f0-9]{64}$'),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_sha256 TEXT NOT NULL CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  responsibility_id TEXT NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  revision BIGINT NOT NULL CHECK (revision = expected_revision + 1),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'reviewed')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 98304),
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, idempotency_sha256),
  UNIQUE (tenant_id, actor_id, responsibility_id, revision),
  FOREIGN KEY (tenant_id, actor_id, responsibility_id) REFERENCES public.omni_responsibilities (tenant_id, actor_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION public.omni_protect_responsibility_drafts_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Responsibility draft history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'Responsibility drafts begin at revision one' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.id IS DISTINCT FROM OLD.id OR
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'Responsibility revision or owner is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT COALESCE(
    NEW.snapshot ?& ARRAY['schemaVersion','id','tenantId','actorId','revision','state','draft','draftSha256','review','createdAt','updatedAt']
    AND NEW.snapshot - ARRAY['schemaVersion','id','tenantId','actorId','revision','state','draft','draftSha256','review','createdAt','updatedAt'] = '{}'::JSONB
    AND NEW.snapshot->'schemaVersion' = '1'::JSONB
    AND NEW.snapshot->>'id' = NEW.id AND NEW.snapshot->>'tenantId' = NEW.tenant_id AND NEW.snapshot->>'actorId' = NEW.actor_id
    AND NEW.snapshot->'revision' = to_jsonb(NEW.revision) AND NEW.snapshot->>'state' = NEW.state
    AND NEW.snapshot->>'draftSha256' = NEW.draft_sha256
    AND (NEW.snapshot->>'createdAt')::TIMESTAMPTZ = NEW.created_at AND (NEW.snapshot->>'updatedAt')::TIMESTAMPTZ = NEW.updated_at
    AND jsonb_typeof(NEW.snapshot->'draft') = 'object'
    AND NEW.snapshot->'draft'->'schemaVersion' = '1'::JSONB
    AND NEW.snapshot->'draft' ?& ARRAY['schemaVersion','purpose','desiredOutcome','sources','cadence','limits','notificationRule','successCondition','stopConditions','work','procedureId','agentId']
    AND (NEW.snapshot->'draft') - ARRAY['schemaVersion','purpose','desiredOutcome','sources','cadence','limits','notificationRule','successCondition','stopConditions','work','procedureId','agentId'] = '{}'::JSONB
    AND jsonb_typeof(NEW.snapshot->'draft'->'sources') = 'array'
    AND jsonb_array_length(NEW.snapshot->'draft'->'sources') <= 20
    AND ((NEW.state = 'draft' AND NEW.snapshot->'review' = 'null'::JSONB) OR
      (NEW.state = 'reviewed' AND jsonb_typeof(NEW.snapshot->'review') = 'object'
        AND NEW.snapshot->'review' ?& ARRAY['schemaVersion','draftSha256','reviewSha256','pins','reviewedAt','authorityEffect','activationSupported']
        AND (NEW.snapshot->'review') - ARRAY['schemaVersion','draftSha256','reviewSha256','pins','reviewedAt','authorityEffect','activationSupported'] = '{}'::JSONB
        AND NEW.snapshot->'review'->'schemaVersion' = '1'::JSONB
        AND NEW.snapshot->'review'->>'draftSha256' = NEW.draft_sha256
        AND NEW.snapshot->'review'->>'reviewSha256' ~ '^[a-f0-9]{64}$'
        AND NEW.snapshot->'review'->>'authorityEffect' = 'none'
        AND NEW.snapshot->'review'->'activationSupported' = 'false'::JSONB
        AND (NEW.snapshot->'review'->>'reviewedAt')::TIMESTAMPTZ = NEW.updated_at)), FALSE
  ) THEN
    RAISE EXCEPTION 'Responsibility draft snapshot does not match its inactive head' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibilities_revision BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibilities
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_drafts_v1();
CREATE TRIGGER omni_responsibilities_no_truncate BEFORE TRUNCATE ON public.omni_responsibilities
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_drafts_v1();

CREATE FUNCTION public.omni_protect_responsibility_mutations_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE head JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Responsibility draft receipts are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT snapshot INTO head FROM public.omni_responsibilities
    WHERE tenant_id = NEW.tenant_id AND actor_id = NEW.actor_id AND id = NEW.responsibility_id AND revision = NEW.revision;
  IF NOT COALESCE(
    head IS NOT NULL AND NEW.receipt->'snapshot' = head
    AND NEW.receipt ?& ARRAY['schemaVersion','id','idempotencySha256','requestSha256','action','expectedRevision','snapshot','savedAt','authorityEffect','activationSupported']
    AND NEW.receipt - ARRAY['schemaVersion','id','idempotencySha256','requestSha256','action','expectedRevision','snapshot','savedAt','authorityEffect','activationSupported'] = '{}'::JSONB
    AND NEW.receipt->'schemaVersion' = '1'::JSONB AND NEW.receipt->>'id' = NEW.id
    AND NEW.receipt->>'idempotencySha256' = NEW.idempotency_sha256 AND NEW.receipt->>'requestSha256' = NEW.request_sha256
    AND NEW.receipt->>'action' = NEW.action AND NEW.receipt->'expectedRevision' = to_jsonb(NEW.expected_revision)
    AND (NEW.receipt->>'savedAt')::TIMESTAMPTZ = NEW.saved_at
    AND NEW.receipt->>'authorityEffect' = 'none' AND NEW.receipt->'activationSupported' = 'false'::JSONB
    AND (NEW.action = 'created') = (NEW.expected_revision = 0)
    AND (NEW.action = 'reviewed') = (head->>'state' = 'reviewed'), FALSE
  ) THEN
    RAISE EXCEPTION 'Responsibility receipt does not match the saved draft revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER omni_responsibility_mutations_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.omni_responsibility_mutations
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_responsibility_mutations_v1();
CREATE TRIGGER omni_responsibility_mutations_no_truncate BEFORE TRUNCATE ON public.omni_responsibility_mutations
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_responsibility_mutations_v1();

CREATE FUNCTION public.omni_require_responsibility_receipt_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.omni_responsibility_mutations mutation
    WHERE mutation.tenant_id = NEW.tenant_id AND mutation.actor_id = NEW.actor_id AND mutation.responsibility_id = NEW.id
      AND mutation.revision = NEW.revision AND mutation.receipt->'snapshot' = NEW.snapshot) THEN
    RAISE EXCEPTION 'Responsibility draft revision requires its immutable receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER omni_responsibilities_receipt_required AFTER INSERT OR UPDATE ON public.omni_responsibilities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.omni_require_responsibility_receipt_v1();

ALTER TABLE public.omni_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_responsibilities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_responsibility_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_responsibility_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_responsibilities AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_responsibilities_actor ON public.omni_responsibilities AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));
CREATE POLICY omni_tenant_isolation ON public.omni_responsibility_mutations AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_responsibility_mutations_actor ON public.omni_responsibility_mutations AS RESTRICTIVE FOR ALL TO PUBLIC
USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id))
WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id));

REVOKE ALL ON public.omni_responsibilities, public.omni_responsibility_mutations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_responsibility_drafts_v1(), public.omni_protect_responsibility_mutations_v1(), public.omni_require_responsibility_receipt_v1() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON public.omni_responsibilities, public.omni_responsibility_mutations FROM omni_runtime;
    GRANT SELECT, INSERT ON public.omni_responsibilities, public.omni_responsibility_mutations TO omni_runtime;
    GRANT UPDATE (revision, state, draft_sha256, snapshot, updated_at) ON public.omni_responsibilities TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON public.omni_responsibilities, public.omni_responsibility_mutations FROM omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_responsibilities, public.omni_responsibility_mutations TO omni_maintenance;
    GRANT UPDATE (revision, state, draft_sha256, snapshot, updated_at) ON public.omni_responsibilities TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON public.omni_responsibilities, public.omni_responsibility_mutations TO omni_backup;
  END IF;
END
$grants$;
INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (216, 'responsibility_drafts_v1', 'df0bcb3b346baef6b3742869a521dc799bd1ab2d999094ed3b61e57da20c72b8', clock_timestamp());
COMMIT;
