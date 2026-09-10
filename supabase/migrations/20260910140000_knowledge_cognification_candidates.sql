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
      'agent_shared_artifact',
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
  retention_expires_at TIMESTAMPTZ,
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
    ) ON UPDATE RESTRICT ON DELETE CASCADE,
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
    AND (
      (
        retention_expires_at IS NULL
        AND contract -> 'retentionExpiresAt' = 'null'::JSONB
      )
      OR (
        retention_expires_at IS NOT NULL
        AND jsonb_typeof(contract -> 'retentionExpiresAt') = 'string'
        AND (contract ->> 'retentionExpiresAt')::TIMESTAMPTZ =
          retention_expires_at
      )
    )
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

CREATE INDEX omni_knowledge_cognition_candidates_retention_idx
ON public.omni_knowledge_cognition_candidates (
  retention_expires_at, tenant_id, owner_actor_id
)
WHERE retention_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.omni_validate_knowledge_cognition_candidate()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_owner_actor_id TEXT;
  source_retention_expires_at TIMESTAMPTZ;
  projected_memory_is_valid BOOLEAN := FALSE;
BEGIN
  IF TG_RELID IS DISTINCT FROM
      'public.omni_knowledge_cognition_candidates'::regclass
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION 'Knowledge cognition validator context is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM NULLIF(
      current_setting('omni.tenant_id', TRUE), ''
    ) OR NOT public.omni_actor_scope_v1_allows(
      NEW.tenant_id, NEW.owner_actor_id
    )
  THEN
    RAISE EXCEPTION 'Knowledge cognition actor scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT revision.owner_actor_id,
         LEAST(
           item.retention_expires_at,
           revision.retention_expires_at,
           all_evidence.retention_expires_at
         )
  INTO source_owner_actor_id, source_retention_expires_at
  FROM public.omni_source_revisions revision
  JOIN public.omni_source_items item
    ON item.tenant_id = revision.tenant_id
   AND item.id = revision.source_item_id
   AND item.current_revision_id = revision.id
   AND item.adapter_operation = 'upsert'
  JOIN public.omni_knowledge_documents document
    ON document.tenant_id = revision.tenant_id
   AND document.id = NEW.document_id
   AND document.source_item_id = revision.source_item_id
   AND document.source_revision_id = revision.id
  JOIN LATERAL (
    SELECT COUNT(*) AS evidence_count
    FROM public.omni_evidence_units evidence
    WHERE evidence.tenant_id = revision.tenant_id
      AND evidence.source_item_id = revision.source_item_id
      AND evidence.source_revision_id = revision.id
      AND evidence.id IN (
        SELECT jsonb_array_elements_text(
          NEW.contract -> 'evidenceUnitIds'
        )
      )
  ) selected_evidence ON selected_evidence.evidence_count =
    jsonb_array_length(NEW.contract -> 'evidenceUnitIds')
  JOIN LATERAL (
    SELECT COUNT(*) AS evidence_count,
           MIN(evidence.retention_expires_at) AS retention_expires_at,
           BOOL_AND(
             evidence.owner_actor_id = NEW.owner_actor_id
             AND evidence.visibility = 'user_private'
             AND evidence.adapter_operation = 'upsert'
             AND 'agent.knowledge.cognify.v1' =
               ANY(evidence.allowed_purpose_ids)
             AND (
               evidence.retention_expires_at IS NULL
               OR evidence.retention_expires_at > NOW()
             )
             AND evidence.captured_at <= NOW()
             AND evidence.extracted_at <= NOW()
           ) AS all_eligible
    FROM public.omni_evidence_units evidence
    WHERE evidence.tenant_id = revision.tenant_id
      AND evidence.source_item_id = revision.source_item_id
      AND evidence.source_revision_id = revision.id
  ) all_evidence ON all_evidence.evidence_count = document.chunk_count
    AND COALESCE(all_evidence.all_eligible, FALSE)
  WHERE revision.tenant_id = NEW.tenant_id
    AND revision.id = NEW.source_revision_id
    AND revision.source_item_id = NEW.source_item_id
    AND revision.owner_actor_id = NEW.owner_actor_id
    AND revision.visibility = 'user_private'
    AND revision.adapter_operation = 'upsert'
    AND revision.captured_at <= NOW()
    AND 'agent.knowledge.cognify.v1' = ANY(revision.allowed_purpose_ids)
    AND item.owner_actor_id = NEW.owner_actor_id
    AND item.visibility = 'user_private'
    AND item.captured_at <= NOW()
    AND 'agent.knowledge.cognify.v1' = ANY(item.allowed_purpose_ids)
    AND (item.retention_expires_at IS NULL OR item.retention_expires_at > NOW())
    AND (
      revision.retention_expires_at IS NULL
      OR revision.retention_expires_at > NOW()
    )
  FOR SHARE OF item, document;

  IF source_owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR source_retention_expires_at IS DISTINCT FROM
      NEW.retention_expires_at
  THEN
    RAISE EXCEPTION 'Knowledge cognition source owner is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.projected_memory_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.omni_memories memory
      JOIN public.omni_auth_user_actor_identifiers memory_identifier
        ON memory_identifier.actor_identifier = memory.owner_actor_id
       AND memory_identifier.identifier_kind = 'canonical'
      JOIN public.omni_auth_user_actor_identifiers source_identifier
        ON source_identifier.actor_identifier = NEW.owner_actor_id
       AND source_identifier.canonical_actor_id =
         memory_identifier.canonical_actor_id
      JOIN public.omni_auth_users auth_user
        ON auth_user.actor_id = memory_identifier.canonical_actor_id
      JOIN public.omni_auth_memberships membership
        ON membership.user_id = auth_user.id
       AND membership.tenant_id = NEW.tenant_id
      WHERE memory.id = NEW.projected_memory_id
        AND memory.tenant_id = NEW.tenant_id
        AND memory.access_contract_version = 1
        AND memory.access_state = 'scope_bound'
        AND memory.visibility = 'user_private'
        AND memory.claim_status = 'active'
        AND memory.asserted_by = 'user'
        AND memory.formation_reason = 'source_cognition'
        AND memory.origin_purpose = 'knowledge.cognition.review.confirm'
        AND memory.source = 'cognify-reviewed:' || NEW.id
        AND ('cognition-review:' || NEW.id) = ANY(memory.evidence_refs)
        AND ('knowledge:' || NEW.document_id) = ANY(memory.evidence_refs)
        AND ('source-revision:' || NEW.source_revision_id) =
          ANY(memory.evidence_refs)
        AND EXISTS (
          SELECT 1
          FROM unnest(memory.evidence_refs) reference
          WHERE reference LIKE 'evidence:%'
        )
        AND auth_user.status = 'active'
        AND membership.status = 'active'
    )
    INTO projected_memory_is_valid;

    IF NOT COALESCE(projected_memory_is_valid, FALSE) THEN
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
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Knowledge cognition history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.schema_version, NEW.id, NEW.tenant_id, NEW.owner_actor_id,
    NEW.document_id, NEW.source_item_id, NEW.source_revision_id,
    NEW.batch_index, NEW.batch_count, NEW.retention_expires_at,
    NEW.model_provider, NEW.model_id,
    NEW.model_assignment_id, NEW.model_assignment_revision,
    NEW.model_configuration_sha256, NEW.model_usage_receipt_id,
    NEW.contract_sha256, NEW.contract, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.id, OLD.tenant_id, OLD.owner_actor_id,
    OLD.document_id, OLD.source_item_id, OLD.source_revision_id,
    OLD.batch_index, OLD.batch_count, OLD.retention_expires_at,
    OLD.model_provider, OLD.model_id,
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

CREATE OR REPLACE FUNCTION
  public.omni_purge_expired_knowledge_cognition_candidates(
    requested_tenant_id TEXT,
    requested_limit INTEGER
  )
RETURNS TABLE(candidate_id TEXT, candidate_tenant_id TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 5000
  THEN
    RAISE EXCEPTION 'Knowledge cognition retention limit is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF requested_tenant_id IS NULL THEN
    IF NOT public.omni_system_scope_enabled() THEN
      RAISE EXCEPTION 'All-tenant cognition retention requires system scope'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT (
    public.omni_system_scope_enabled()
    OR public.omni_tenant_visible(requested_tenant_id)
  ) THEN
    RAISE EXCEPTION 'Cognition retention tenant scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH expired AS MATERIALIZED (
    SELECT candidate.ctid, candidate.projected_memory_id
    FROM public.omni_knowledge_cognition_candidates candidate
    WHERE (
        (
          candidate.retention_expires_at IS NOT NULL
          AND candidate.retention_expires_at <= NOW()
        )
        OR NOT EXISTS (
          SELECT 1
          FROM public.omni_source_revisions revision
          JOIN public.omni_source_items item
            ON item.tenant_id = revision.tenant_id
           AND item.id = revision.source_item_id
           AND item.current_revision_id = revision.id
           AND item.adapter_operation = 'upsert'
          JOIN public.omni_knowledge_documents document
            ON document.tenant_id = revision.tenant_id
           AND document.id = candidate.document_id
           AND document.source_item_id = revision.source_item_id
           AND document.source_revision_id = revision.id
          JOIN LATERAL (
            SELECT COUNT(*) AS evidence_count,
                   MIN(evidence.retention_expires_at) AS retention_expires_at,
                   BOOL_AND(
                     evidence.owner_actor_id = candidate.owner_actor_id
                     AND evidence.visibility = 'user_private'
                     AND evidence.adapter_operation = 'upsert'
                     AND 'agent.knowledge.cognify.v1' =
                       ANY(evidence.allowed_purpose_ids)
                     AND (
                       evidence.retention_expires_at IS NULL
                       OR evidence.retention_expires_at > NOW()
                     )
                     AND evidence.captured_at <= NOW()
                     AND evidence.extracted_at <= NOW()
                   ) AS all_eligible
            FROM public.omni_evidence_units evidence
            WHERE evidence.tenant_id = revision.tenant_id
              AND evidence.source_item_id = revision.source_item_id
              AND evidence.source_revision_id = revision.id
          ) all_evidence
            ON all_evidence.evidence_count = document.chunk_count
           AND COALESCE(all_evidence.all_eligible, FALSE)
          WHERE revision.tenant_id = candidate.tenant_id
            AND revision.id = candidate.source_revision_id
            AND revision.source_item_id = candidate.source_item_id
            AND revision.owner_actor_id = candidate.owner_actor_id
            AND revision.visibility = 'user_private'
            AND revision.adapter_operation = 'upsert'
            AND revision.captured_at <= NOW()
            AND 'agent.knowledge.cognify.v1' =
              ANY(revision.allowed_purpose_ids)
            AND item.owner_actor_id = candidate.owner_actor_id
            AND item.visibility = 'user_private'
            AND item.captured_at <= NOW()
            AND 'agent.knowledge.cognify.v1' =
              ANY(item.allowed_purpose_ids)
            AND (
              item.retention_expires_at IS NULL
              OR item.retention_expires_at > NOW()
            )
            AND (
              revision.retention_expires_at IS NULL
              OR revision.retention_expires_at > NOW()
            )
            AND LEAST(
              item.retention_expires_at,
              revision.retention_expires_at,
              all_evidence.retention_expires_at
            ) IS NOT DISTINCT FROM candidate.retention_expires_at
        )
      )
      AND (
        requested_tenant_id IS NULL
        OR candidate.tenant_id = requested_tenant_id
      )
    ORDER BY candidate.retention_expires_at,
      candidate.tenant_id COLLATE "C", candidate.id COLLATE "C"
    FOR UPDATE SKIP LOCKED
    LIMIT requested_limit
  ), marked_memories AS (
    UPDATE public.omni_memories memory
    SET retention_expires_at = LEAST(
          COALESCE(memory.retention_expires_at, NOW()),
          NOW()
        ),
        updated_at = NOW()
    FROM expired
    WHERE expired.projected_memory_id IS NOT NULL
      AND memory.id = expired.projected_memory_id
      AND memory.formation_reason = 'source_cognition'
      AND memory.claim_status <> 'forgotten'
    RETURNING memory.id
  ), deleted AS (
    DELETE FROM public.omni_knowledge_cognition_candidates candidate
    USING expired
    WHERE candidate.ctid = expired.ctid
    RETURNING candidate.id, candidate.tenant_id
  )
  SELECT deleted.id, deleted.tenant_id
  FROM deleted
  LEFT JOIN (SELECT COUNT(*) FROM marked_memories) applied ON TRUE;
END
$function$;

CREATE OR REPLACE FUNCTION
  public.omni_retire_knowledge_cognition_memories_v1(
    requested_tenant_id TEXT,
    requested_source_owner_actor_id TEXT,
    requested_document_ids TEXT[],
    requested_retired_at TIMESTAMPTZ
  )
RETURNS TABLE(
  retired_memory_ids TEXT[],
  retrieval_trace_ids TEXT[],
  canonical_owner_actor_id TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  resolved_canonical_actor_id TEXT;
  target_memory_ids TEXT[] := '{}'::TEXT[];
  updated_memory_ids TEXT[] := '{}'::TEXT[];
  affected_trace_ids TEXT[] := '{}'::TEXT[];
BEGIN
  IF requested_tenant_id IS NULL
    OR requested_source_owner_actor_id IS NULL
    OR requested_retired_at IS NULL
    OR requested_document_ids IS NULL
    OR cardinality(requested_document_ids) < 1
    OR cardinality(requested_document_ids) > 5000
    OR EXISTS (
      SELECT 1
      FROM unnest(requested_document_ids) requested(document_id)
      WHERE document_id IS NULL
        OR NOT public.omni_source_contract_id_is_valid(document_id)
    )
    OR (
      SELECT COUNT(DISTINCT document_id)
      FROM unnest(requested_document_ids) requested(document_id)
    ) <> cardinality(requested_document_ids)
  THEN
    RAISE EXCEPTION 'Knowledge cognition lifecycle input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(current_setting('omni.tenant_id', TRUE), '')
      IS DISTINCT FROM requested_tenant_id
    OR public.omni_current_memory_access_scope_v1() IS NOT NULL
    OR NOT (
      public.omni_actor_scope_v1_allows(
        requested_tenant_id, requested_source_owner_actor_id
      )
      OR public.omni_actor_scope_v1_allows_canonical(
        requested_tenant_id, requested_source_owner_actor_id
      )
    )
  THEN
    RAISE EXCEPTION 'Knowledge cognition lifecycle scope is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT identifier.canonical_actor_id
  INTO resolved_canonical_actor_id
  FROM public.omni_auth_user_actor_identifiers identifier
  JOIN public.omni_auth_users auth_user
    ON auth_user.actor_id = identifier.canonical_actor_id
   AND auth_user.status = 'active'
  JOIN public.omni_auth_memberships membership
    ON membership.user_id = auth_user.id
   AND membership.tenant_id = requested_tenant_id
   AND membership.status = 'active'
  WHERE identifier.actor_identifier = requested_source_owner_actor_id;
  IF resolved_canonical_actor_id IS NULL THEN
    RAISE EXCEPTION 'Knowledge cognition lifecycle owner is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    ARRAY_AGG(DISTINCT memory.id ORDER BY memory.id),
    '{}'::TEXT[]
  )
  INTO target_memory_ids
  FROM public.omni_knowledge_cognition_candidates candidate
  JOIN public.omni_knowledge_documents document
    ON document.tenant_id = candidate.tenant_id
   AND document.id = candidate.document_id
   AND document.source_item_id = candidate.source_item_id
   AND document.source_revision_id = candidate.source_revision_id
  JOIN public.omni_source_revisions revision
    ON revision.tenant_id = document.tenant_id
   AND revision.id = document.source_revision_id
   AND revision.source_item_id = document.source_item_id
   AND revision.owner_actor_id = requested_source_owner_actor_id
  JOIN public.omni_source_items item
    ON item.tenant_id = revision.tenant_id
   AND item.id = revision.source_item_id
   AND item.owner_actor_id = requested_source_owner_actor_id
  JOIN public.omni_memories memory
    ON memory.id = candidate.projected_memory_id
   AND memory.tenant_id = candidate.tenant_id
   AND memory.owner_actor_id = resolved_canonical_actor_id
  WHERE candidate.tenant_id = requested_tenant_id
    AND candidate.owner_actor_id = requested_source_owner_actor_id
    AND candidate.document_id = ANY(requested_document_ids)
    AND candidate.status = 'confirmed'
    AND candidate.projected_memory_id IS NOT NULL
    AND memory.access_contract_version = 1
    AND memory.access_state = 'scope_bound'
    AND memory.visibility = 'user_private'
    AND memory.formation_reason = 'source_cognition'
    AND memory.origin_purpose = 'knowledge.cognition.review.confirm'
    AND memory.source = 'cognify-reviewed:' || candidate.id
    AND ('cognition-review:' || candidate.id) = ANY(memory.evidence_refs)
    AND ('knowledge:' || candidate.document_id) = ANY(memory.evidence_refs)
    AND ('source-revision:' || candidate.source_revision_id) =
      ANY(memory.evidence_refs)
    AND memory.claim_status <> 'forgotten';

  IF cardinality(target_memory_ids) = 0 THEN
    RETURN QUERY SELECT
      '{}'::TEXT[], '{}'::TEXT[], resolved_canonical_actor_id;
    RETURN;
  END IF;

  WITH updated AS (
    UPDATE public.omni_memories memory
    SET title = '[retired]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[retired]',
        embedding = NULL,
        embedding_vector = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        claim_status = 'superseded',
        valid_to = COALESCE(memory.valid_to, requested_retired_at),
        forgotten_at = NULL,
        updated_at = requested_retired_at
    WHERE memory.tenant_id = requested_tenant_id
      AND memory.id = ANY(target_memory_ids)
      AND memory.claim_status <> 'forgotten'
      AND NOT public.omni_memory_ids_have_deletion_barrier(
        memory.tenant_id, ARRAY[memory.id]
      )
    RETURNING memory.id
  )
  SELECT COALESCE(
    ARRAY_AGG(updated.id ORDER BY updated.id),
    '{}'::TEXT[]
  ) INTO updated_memory_ids
  FROM updated;

  SELECT COALESCE(
    ARRAY_AGG(trace.id ORDER BY trace.id),
    '{}'::TEXT[]
  )
  INTO affected_trace_ids
  FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = requested_tenant_id
    AND trace.memory_ids && updated_memory_ids;

  DELETE FROM public.omni_memory_graph_edges edge
  WHERE edge.tenant_id = requested_tenant_id
    AND (
      edge.memory_ids && updated_memory_ids
      OR EXISTS (
        SELECT 1
        FROM public.omni_memory_graph_nodes endpoint
        WHERE endpoint.tenant_id = edge.tenant_id
          AND endpoint.id IN (edge.source_node_id, edge.target_node_id)
          AND endpoint.memory_ids && updated_memory_ids
      )
    );
  DELETE FROM public.omni_memory_graph_nodes node
  WHERE node.tenant_id = requested_tenant_id
    AND node.memory_ids && updated_memory_ids;
  DELETE FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = requested_tenant_id
    AND trace.id = ANY(affected_trace_ids);
  INSERT INTO public.omni_memory_graph_rebuild_queue AS rebuild (
    tenant_id, requested_at, attempts, last_error, updated_at, generation
  ) VALUES (
    requested_tenant_id, NOW(), 0, NULL, NOW(), 1
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    requested_at = NOW(), attempts = 0, last_error = NULL,
    updated_at = NOW(), generation = rebuild.generation + 1;

  RETURN QUERY SELECT
    updated_memory_ids,
    affected_trace_ids,
    resolved_canonical_actor_id;
END
$function$;

CREATE TRIGGER omni_knowledge_cognition_candidates_validate
BEFORE INSERT OR UPDATE ON public.omni_knowledge_cognition_candidates
FOR EACH ROW
EXECUTE FUNCTION public.omni_validate_knowledge_cognition_candidate();

CREATE TRIGGER omni_knowledge_cognition_candidates_protect
BEFORE UPDATE ON public.omni_knowledge_cognition_candidates
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
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
  OR public.omni_actor_scope_v1_allows_canonical(
    tenant_id, owner_actor_id
  )
);

REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_validate_knowledge_cognition_candidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_protect_knowledge_cognition_candidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_purge_expired_knowledge_cognition_candidates(TEXT, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.omni_retire_knowledge_cognition_memories_v1(
    TEXT, TEXT, TEXT[], TIMESTAMPTZ
  ) FROM PUBLIC;

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
    GRANT EXECUTE ON FUNCTION
      public.omni_purge_expired_knowledge_cognition_candidates(TEXT, INTEGER)
      TO omni_runtime;
    GRANT EXECUTE ON FUNCTION
      public.omni_retire_knowledge_cognition_memories_v1(
        TEXT, TEXT, TEXT[], TIMESTAMPTZ
      ) TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE public.omni_knowledge_cognition_candidates
      FROM omni_maintenance;
    GRANT SELECT ON public.omni_knowledge_cognition_candidates
      TO omni_maintenance;
    GRANT EXECUTE ON FUNCTION
      public.omni_purge_expired_knowledge_cognition_candidates(TEXT, INTEGER)
      TO omni_maintenance;
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
      AND pg_get_constraintdef(oid) LIKE '%agent_shared_artifact%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid =
      'public.omni_validate_knowledge_cognition_candidate()'::regprocedure
      AND prosecdef
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid =
      'public.omni_retire_knowledge_cognition_memories_v1(text,text,text[],timestamptz)'::regprocedure
      AND prosecdef
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid =
      'public.omni_purge_expired_knowledge_cognition_candidates(text,integer)'::regprocedure
      AND prosecdef
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
      'public.omni_knowledge_cognition_candidates'::regclass
      AND conname = 'omni_knowledge_cognition_candidates_document_fkey'
      AND confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid =
      'public.omni_knowledge_cognition_candidates'::regclass
      AND polname = 'omni_knowledge_cognition_candidates_actor_scope'
      AND pg_get_expr(polqual, polrelid) LIKE
        '%omni_actor_scope_v1_allows%'
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
  'c14f3308088df1ce4eb94f7208580b91bc574efe7479bf2832d2f2ba853cac1e',
  clock_timestamp()
);

COMMIT;
