BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE
  latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 154 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 154
      AND name = 'media_computer_model_scopes_v1'
      AND checksum =
        'a8aa943ab72aed3c2d80a7d6abf46efb206b64ed476a6f674298a6e0eb1343f2'
  ) <> 1 THEN
    RAISE EXCEPTION 'Knowledge cognition predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE public.omni_memories
  DROP CONSTRAINT IF EXISTS omni_memories_tier_policy_check;
ALTER TABLE public.omni_memories
  ADD CONSTRAINT omni_memories_tier_policy_check CHECK (
    tier IN (
      'working', 'episodic', 'semantic', 'procedural',
      'preference', 'decision', 'commitment', 'summary'
    )
    AND tier_policy_version = 1
    AND formation_reason IN (
      'manual_user_entry', 'explicit_user_request',
      'canonical_source_observation', 'verified_effect',
      'assistant_inference_candidate', 'correction',
      'project_reflection', 'project_artifact', 'workflow_output',
      'maintenance_promotion', 'source_cognition',
      'portable_restore', 'legacy_record'
    )
    AND use_count >= 0
    AND (
      (promoted_from_tier IS NULL AND promoted_at IS NULL)
      OR (
        promoted_from_tier IN (
          'working', 'episodic', 'semantic', 'procedural',
          'preference', 'decision', 'commitment', 'summary'
        )
        AND promoted_from_tier <> tier
        AND promoted_at IS NOT NULL
      )
    )
  ) NOT VALID;
ALTER TABLE public.omni_memories
  VALIDATE CONSTRAINT omni_memories_tier_policy_check;

CREATE TABLE public.omni_knowledge_cognition_candidates (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_assignment_id TEXT,
  model_assignment_revision BIGINT,
  model_configuration_sha256 TEXT,
  model_usage_receipt_id TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  contract JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  reviewed_by_actor_id TEXT,
  review_decision TEXT,
  review_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at TIMESTAMPTZ,
  projected_memory_id TEXT,
  projected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT omni_knowledge_cognition_candidates_pkey
    PRIMARY KEY (tenant_id, id),
  CONSTRAINT omni_knowledge_cognition_candidates_contract_key
    UNIQUE (tenant_id, contract_sha256),
  CONSTRAINT omni_knowledge_cognition_candidates_document_fkey
    FOREIGN KEY (tenant_id, document_id, source_revision_id)
    REFERENCES public.omni_knowledge_documents (
      tenant_id, id, source_revision_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_knowledge_cognition_candidates_revision_fkey
    FOREIGN KEY (tenant_id, source_revision_id, source_item_id)
    REFERENCES public.omni_source_revisions (
      tenant_id, id, source_item_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_knowledge_cognition_candidates_memory_fkey
    FOREIGN KEY (projected_memory_id)
    REFERENCES public.omni_memories (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT omni_knowledge_cognition_candidates_row_check CHECK (COALESCE(
    schema_version = 1
    AND public.omni_source_contract_id_is_valid(id)
    AND public.omni_source_contract_id_is_valid(tenant_id)
    AND public.omni_source_contract_id_is_valid(owner_actor_id)
    AND public.omni_source_contract_id_is_valid(document_id)
    AND public.omni_source_contract_id_is_valid(source_item_id)
    AND public.omni_source_contract_id_is_valid(source_revision_id)
    AND public.omni_source_contract_id_is_valid(model_provider)
    AND public.omni_source_contract_id_is_valid(model_id)
    AND public.omni_source_contract_id_is_valid(model_usage_receipt_id)
    AND batch_index >= 0
    AND batch_count BETWEEN 1 AND 10000
    AND batch_index < batch_count
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(contract) = 'object'
    AND octet_length(contract::TEXT) <= 1048576
    AND contract ->> 'contractKind' = 'cognification_candidate_batch'
    AND contract ->> 'candidateOnly' = 'true'
    AND contract ->> 'batchId' = id
    AND contract ->> 'tenantId' = tenant_id
    AND contract ->> 'ownerActorId' = owner_actor_id
    AND contract ->> 'documentId' = document_id
    AND contract ->> 'sourceItemId' = source_item_id
    AND contract ->> 'sourceRevisionId' = source_revision_id
    AND (contract ->> 'batchIndex')::INTEGER = batch_index
    AND (contract ->> 'batchCount')::INTEGER = batch_count
    AND contract ->> 'contractSha256' = contract_sha256
    AND contract #>> '{modelAttribution,provider}' = model_provider
    AND contract #>> '{modelAttribution,model}' = model_id
    AND contract #>> '{modelAttribution,usageReceiptId}' =
      model_usage_receipt_id
    AND (
      (
        model_assignment_id IS NULL
        AND model_assignment_revision IS NULL
        AND model_configuration_sha256 IS NULL
      )
      OR (
        public.omni_source_contract_id_is_valid(model_assignment_id)
        AND model_assignment_revision BETWEEN 1 AND 9007199254740991
        AND model_configuration_sha256 ~ '^[0-9a-f]{64}$'
        AND contract #>> '{modelAttribution,assignmentId}' =
          model_assignment_id
        AND (contract #>> '{modelAttribution,assignmentRevision}')::BIGINT =
          model_assignment_revision
        AND contract #>>
          '{modelAttribution,assignmentConfigurationSha256}' =
          model_configuration_sha256
      )
    )
    AND jsonb_typeof(review_metadata) = 'object'
    AND octet_length(review_metadata::TEXT) <= 8192
    AND created_at <= updated_at
    AND (
      (
        status = 'pending_review'
        AND reviewed_by_actor_id IS NULL
        AND review_decision IS NULL
        AND review_metadata = '{}'::jsonb
        AND reviewed_at IS NULL
        AND projected_memory_id IS NULL
        AND projected_at IS NULL
        AND created_at = updated_at
      )
      OR (
        status = 'confirmed'
        AND reviewed_by_actor_id = owner_actor_id
        AND review_decision = 'confirm'
        AND reviewed_at IS NOT NULL
        AND created_at <= reviewed_at
        AND reviewed_at <= updated_at
        AND (
          (
            projected_memory_id IS NULL
            AND projected_at IS NULL
            AND reviewed_at = updated_at
          )
          OR (
            public.omni_source_contract_id_is_valid(projected_memory_id)
            AND projected_at IS NOT NULL
            AND reviewed_at <= projected_at
            AND projected_at = updated_at
          )
        )
      )
      OR (
        status = 'dismissed'
        AND reviewed_by_actor_id = owner_actor_id
        AND review_decision = 'dismiss'
        AND reviewed_at IS NOT NULL
        AND reviewed_at = updated_at
        AND projected_memory_id IS NULL
        AND projected_at IS NULL
      )
    )
  , FALSE))
);

CREATE INDEX omni_knowledge_cognition_candidates_pending_idx
ON public.omni_knowledge_cognition_candidates (
  tenant_id, owner_actor_id, created_at, id
)
WHERE status = 'pending_review';

CREATE INDEX omni_knowledge_cognition_candidates_document_idx
ON public.omni_knowledge_cognition_candidates (
  tenant_id, owner_actor_id, document_id, batch_index
);

CREATE OR REPLACE FUNCTION public.omni_validate_knowledge_cognition_candidate()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_owner_actor_id TEXT;
  memory_owner_actor_id TEXT;
  memory_tenant_id TEXT;
  memory_status TEXT;
  memory_formation_reason TEXT;
BEGIN
  SELECT revision.owner_actor_id
  INTO source_owner_actor_id
  FROM public.omni_source_revisions revision
  WHERE revision.tenant_id = NEW.tenant_id
    AND revision.id = NEW.source_revision_id
    AND revision.source_item_id = NEW.source_item_id;

  IF source_owner_actor_id IS DISTINCT FROM NEW.owner_actor_id THEN
    RAISE EXCEPTION 'Knowledge cognition source owner is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.projected_memory_id IS NOT NULL THEN
    SELECT memory.tenant_id, memory.owner_actor_id, memory.claim_status,
           memory.formation_reason
    INTO memory_tenant_id, memory_owner_actor_id, memory_status,
         memory_formation_reason
    FROM public.omni_memories memory
    WHERE memory.id = NEW.projected_memory_id;

    IF memory_tenant_id IS DISTINCT FROM NEW.tenant_id
      OR memory_owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
      OR memory_status IS DISTINCT FROM 'active'
      OR memory_formation_reason IS DISTINCT FROM 'source_cognition'
    THEN
      RAISE EXCEPTION 'Knowledge cognition projected memory is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_knowledge_cognition_candidate()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Knowledge cognition history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.schema_version, NEW.id, NEW.tenant_id, NEW.owner_actor_id,
    NEW.document_id, NEW.source_item_id, NEW.source_revision_id,
    NEW.batch_index, NEW.batch_count, NEW.model_provider, NEW.model_id,
    NEW.model_assignment_id, NEW.model_assignment_revision,
    NEW.model_configuration_sha256, NEW.model_usage_receipt_id,
    NEW.contract_sha256, NEW.contract, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.id, OLD.tenant_id, OLD.owner_actor_id,
    OLD.document_id, OLD.source_item_id, OLD.source_revision_id,
    OLD.batch_index, OLD.batch_count, OLD.model_provider, OLD.model_id,
    OLD.model_assignment_id, OLD.model_assignment_revision,
    OLD.model_configuration_sha256, OLD.model_usage_receipt_id,
    OLD.contract_sha256, OLD.contract, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Knowledge cognition evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending_review' THEN
    IF NEW.status NOT IN ('confirmed', 'dismissed')
      OR NEW.reviewed_by_actor_id IS DISTINCT FROM OLD.owner_actor_id
      OR NEW.reviewed_at IS NULL
      OR NEW.projected_memory_id IS NOT NULL
      OR NEW.projected_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Knowledge cognition review transition is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'confirmed'
    AND OLD.projected_memory_id IS NULL
  THEN
    IF NEW.status IS DISTINCT FROM 'confirmed'
      OR NEW.reviewed_by_actor_id IS DISTINCT FROM OLD.reviewed_by_actor_id
      OR NEW.review_decision IS DISTINCT FROM OLD.review_decision
      OR NEW.review_metadata IS DISTINCT FROM OLD.review_metadata
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.projected_memory_id IS NULL
      OR NEW.projected_at IS NULL
    THEN
      RAISE EXCEPTION 'Knowledge cognition projection transition is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Knowledge cognition terminal state is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_knowledge_cognition_candidates_validate
BEFORE INSERT OR UPDATE ON public.omni_knowledge_cognition_candidates
FOR EACH ROW
EXECUTE FUNCTION public.omni_validate_knowledge_cognition_candidate();

CREATE TRIGGER omni_knowledge_cognition_candidates_protect
BEFORE UPDATE OR DELETE ON public.omni_knowledge_cognition_candidates
FOR EACH ROW
EXECUTE FUNCTION public.omni_protect_knowledge_cognition_candidate();

CREATE TRIGGER omni_knowledge_cognition_candidates_no_truncate
BEFORE TRUNCATE ON public.omni_knowledge_cognition_candidates
FOR EACH STATEMENT
EXECUTE FUNCTION public.omni_protect_knowledge_cognition_candidate();

ALTER TABLE public.omni_knowledge_cognition_candidates
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_knowledge_cognition_candidates
  FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_tenant_isolation
ON public.omni_knowledge_cognition_candidates
AS PERMISSIVE FOR ALL TO PUBLIC
USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));

CREATE POLICY omni_knowledge_cognition_candidates_actor_scope
ON public.omni_knowledge_cognition_candidates
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
);

REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_validate_knowledge_cognition_candidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_protect_knowledge_cognition_candidate() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates
      FROM omni_runtime;
    GRANT SELECT, INSERT ON public.omni_knowledge_cognition_candidates
      TO omni_runtime;
    GRANT UPDATE (
      status, reviewed_by_actor_id, review_decision, review_metadata,
      reviewed_at, projected_memory_id, projected_at, updated_at
    ) ON public.omni_knowledge_cognition_candidates TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates
      FROM omni_maintenance;
    GRANT SELECT, INSERT ON public.omni_knowledge_cognition_candidates
      TO omni_maintenance;
    GRANT UPDATE (
      status, reviewed_by_actor_id, review_decision, review_metadata,
      reviewed_at, projected_memory_id, projected_at, updated_at
    ) ON public.omni_knowledge_cognition_candidates TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates
      FROM omni_backup;
    GRANT SELECT ON public.omni_knowledge_cognition_candidates TO omni_backup;
  END IF;
END
$grants$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_knowledge_cognition_candidates'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid =
      'public.omni_knowledge_cognition_candidates'::regclass
      AND polname = 'omni_knowledge_cognition_candidates_actor_scope'
      AND NOT polpermissive
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid =
      'public.omni_knowledge_cognition_candidates'::regclass
      AND tgname = 'omni_knowledge_cognition_candidates_no_truncate'
      AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'omni_knowledge_cognition_candidates'
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('DELETE', 'TRUNCATE')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omni_memories'::regclass
      AND conname = 'omni_memories_tier_policy_check'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%source_cognition%'
  ) THEN
    RAISE EXCEPTION 'Knowledge cognition persistence boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  155,
  'knowledge_cognification_candidates_v1',
  '7be9cf9382966145ef45ed3dc5e7ce9ad4b9717592b9fc7200ad23bdf1776185',
  clock_timestamp()
);

COMMIT;
