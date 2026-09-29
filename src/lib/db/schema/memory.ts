import "server-only";

import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for memory: claims, tiers, reconciliation,
// formation, graph rebuilds, deletion barriers and access scope.

export async function ensureClaimBasedMemory(sql: SqlClient) {
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS asserted_by TEXT NOT NULL DEFAULT 'system'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS evidence_refs TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS supersedes_id TEXT`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS contradiction_of_id TEXT`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_claim_status_idx ON omni_memories (tenant_id, claim_status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_supersedes_idx ON omni_memories (tenant_id, supersedes_id)`;
}

export async function ensurePersistedAnswerGrounding(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS grounding JSONB`;
}

export async function ensureMemoryTierPolicyV1(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'semantic'
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS tier_policy_version SMALLINT NOT NULL DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS formation_reason TEXT NOT NULL DEFAULT 'legacy_record'
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS use_count BIGINT NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS promoted_from_tier TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ
  `;

  await sql`
    UPDATE omni_memories
    SET tier = CASE type
          WHEN 'preference' THEN 'preference'
          WHEN 'episode' THEN 'episodic'
          WHEN 'procedure' THEN 'procedural'
          WHEN 'decision' THEN 'decision'
          WHEN 'task' THEN 'commitment'
          ELSE 'semantic'
        END,
        tier_policy_version = 1,
        formation_reason = CASE
          WHEN supersedes_id IS NOT NULL OR source LIKE 'correction:%'
            THEN 'correction'
          WHEN source = 'manual' THEN 'manual_user_entry'
          WHEN source = 'user-assertion' THEN 'explicit_user_request'
          WHEN source = 'assistant-inference'
            THEN 'assistant_inference_candidate'
          WHEN source = 'effect-receipt' THEN 'verified_effect'
          WHEN source LIKE 'portable-restore:%' THEN 'portable_restore'
          WHEN source ILIKE '%reflection%' THEN 'project_reflection'
          WHEN source ILIKE '%artifact%' THEN 'project_artifact'
          WHEN source ILIKE '%workflow%' THEN 'workflow_output'
          WHEN type = 'knowledge' AND cardinality(evidence_refs) > 0
            THEN 'canonical_source_observation'
          ELSE 'legacy_record'
        END,
        retention_expires_at = CASE
          WHEN type = 'episode'
            THEN created_at + INTERVAL '30 days'
          WHEN type = 'task' THEN valid_to
          WHEN source = 'consolidator'
            THEN created_at + INTERVAL '365 days'
          ELSE retention_expires_at
        END,
        use_count = COALESCE(use_count, 0)
    WHERE claim_status <> 'forgotten'
      AND NOT omni_memory_ids_have_deletion_barrier(
        tenant_id,
        ARRAY[id]
      )
  `;

  await sql`
    WITH usage AS (
      SELECT memory.id,
             MAX(trace.created_at) AS last_used_at,
             COUNT(*)::BIGINT AS use_count
      FROM omni_memories memory
      JOIN omni_retrieval_traces trace
        ON trace.tenant_id = memory.tenant_id
       AND memory.id = ANY(trace.memory_ids)
      WHERE memory.claim_status <> 'forgotten'
        AND NOT omni_memory_ids_have_deletion_barrier(
          memory.tenant_id,
          ARRAY[memory.id]
        )
      GROUP BY memory.id
    )
    UPDATE omni_memories memory
    SET last_used_at = usage.last_used_at,
        use_count = usage.use_count
    FROM usage
    WHERE memory.id = usage.id
      AND (
        memory.last_used_at IS DISTINCT FROM usage.last_used_at
        OR memory.use_count IS DISTINCT FROM usage.use_count
      )
  `;
  // The permanent deletion and graph barriers use deferred constraint
  // triggers. Validate the backfill before issuing more ALTER TABLE commands
  // in this same atomic migration.
  await sql`SET CONSTRAINTS ALL IMMEDIATE`;

  await sql`ALTER TABLE omni_memories ALTER COLUMN tier SET NOT NULL`;
  await sql`ALTER TABLE omni_memories ALTER COLUMN tier SET DEFAULT 'semantic'`;
  await sql`
    ALTER TABLE omni_memories
    ALTER COLUMN tier_policy_version SET DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_memories
    ALTER COLUMN tier_policy_version SET NOT NULL
  `;
  await sql`
    ALTER TABLE omni_memories
    ALTER COLUMN formation_reason SET DEFAULT 'legacy_record'
  `;
  await sql`
    ALTER TABLE omni_memories
    ALTER COLUMN formation_reason SET NOT NULL
  `;
  await sql`ALTER TABLE omni_memories ALTER COLUMN use_count SET DEFAULT 0`;
  await sql`ALTER TABLE omni_memories ALTER COLUMN use_count SET NOT NULL`;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_tier_policy_check'
      ) THEN
        ALTER TABLE omni_memories
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
            'source_cognition', 'portable_restore', 'legacy_record'
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
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_tier_policy_check
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_tier_active_idx
    ON omni_memories (tenant_id, tier, updated_at DESC)
    WHERE claim_status = 'active'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_retention_expiry_idx
    ON omni_memories (retention_expires_at, tenant_id, id)
    WHERE retention_expires_at IS NOT NULL
      AND claim_status <> 'forgotten'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_last_used_idx
    ON omni_memories (tenant_id, last_used_at DESC)
    WHERE last_used_at IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_record_memory_retrieval_usage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      UPDATE public.omni_memories memory
      SET last_used_at = GREATEST(
            COALESCE(memory.last_used_at, NEW.created_at),
            NEW.created_at
          ),
          use_count = memory.use_count + 1
      WHERE memory.tenant_id = NEW.tenant_id
        AND memory.id = ANY(NEW.memory_ids)
        AND memory.claim_status <> 'forgotten';
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_record_memory_retrieval_usage()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_record_memory_usage
    ON omni_retrieval_traces
  `;
  await sql`
    CREATE TRIGGER omni_retrieval_traces_record_memory_usage
    AFTER INSERT ON omni_retrieval_traces
    FOR EACH ROW
    WHEN (cardinality(NEW.memory_ids) > 0)
    EXECUTE FUNCTION omni_record_memory_retrieval_usage()
  `;
}

export async function ensureMemoryReconciliationInboxV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_reconciliation_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      detection_reason TEXT NOT NULL,
      candidate_memory_id TEXT NOT NULL REFERENCES omni_memories(id),
      existing_memory_id TEXT REFERENCES omni_memories(id),
      resolved_by TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_reconciliation_candidate_key
        UNIQUE (tenant_id, candidate_memory_id),
      CONSTRAINT omni_memory_reconciliation_shape_check CHECK (
        kind IN ('confirmation', 'contradiction')
        AND status IN ('pending', 'resolved')
        AND detection_reason IN (
          'unconfirmed_candidate', 'unverified_inference',
          'unverified_workflow_output', 'similar_claim_conflict',
          'explicit_contradiction', 'legacy_candidate'
        )
        AND (owner_actor_id IS NULL
          OR omni_source_contract_id_is_valid(owner_actor_id))
        AND candidate_memory_id <> COALESCE(existing_memory_id, '')
        AND (
          (kind = 'confirmation' AND existing_memory_id IS NULL)
          OR (kind = 'contradiction' AND existing_memory_id IS NOT NULL)
        )
        AND (
          (
            status = 'pending'
            AND decision IS NULL
            AND resolved_by IS NULL
            AND resolved_at IS NULL
          )
          OR (
            status = 'resolved'
            AND decision IN (
              'confirm_candidate', 'keep_existing', 'keep_both'
            )
            AND NOT (kind = 'confirmation' AND decision = 'keep_both')
            AND omni_source_contract_id_is_valid(resolved_by)
            AND resolved_at IS NOT NULL
          )
        )
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_reconciliation_pending_idx
    ON omni_memory_reconciliation_reviews (
      tenant_id, owner_actor_id, created_at DESC, id
    )
    WHERE status = 'pending'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_reconciliation_existing_idx
    ON omni_memory_reconciliation_reviews (
      tenant_id, existing_memory_id, created_at DESC
    )
    WHERE existing_memory_id IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_reconciliation_identity()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      candidate_memory public.omni_memories%ROWTYPE;
      existing_memory public.omni_memories%ROWTYPE;
    BEGIN
      IF TG_OP = 'UPDATE'
        AND ROW(
          OLD.tenant_id, OLD.owner_actor_id, OLD.kind,
          OLD.detection_reason, OLD.candidate_memory_id,
          OLD.existing_memory_id, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id, NEW.owner_actor_id, NEW.kind,
          NEW.detection_reason, NEW.candidate_memory_id,
          NEW.existing_memory_id, NEW.created_at
        )
      THEN
        RAISE EXCEPTION 'Memory reconciliation identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      SELECT * INTO candidate_memory
      FROM public.omni_memories memory
      WHERE memory.tenant_id = NEW.tenant_id
        AND memory.id = NEW.candidate_memory_id;
      IF NOT FOUND
        OR candidate_memory.claim_status = 'forgotten'
        OR candidate_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
      THEN
        RAISE EXCEPTION 'Memory reconciliation candidate is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.existing_memory_id IS NOT NULL THEN
        SELECT * INTO existing_memory
        FROM public.omni_memories memory
        WHERE memory.tenant_id = NEW.tenant_id
          AND memory.id = NEW.existing_memory_id;
        IF NOT FOUND
          OR existing_memory.claim_status = 'forgotten'
          OR existing_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        THEN
          RAISE EXCEPTION 'Memory reconciliation existing claim is invalid'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_memory_reconciliation_identity()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_reconciliation_identity
    ON omni_memory_reconciliation_reviews
  `;
  await sql`
    CREATE TRIGGER omni_memory_reconciliation_identity
    BEFORE INSERT OR UPDATE
    ON omni_memory_reconciliation_reviews
    FOR EACH ROW
    EXECUTE FUNCTION omni_validate_memory_reconciliation_identity()
  `;

  await sql`
    INSERT INTO omni_memory_reconciliation_reviews (
      id, tenant_id, owner_actor_id, kind, status, decision,
      detection_reason, candidate_memory_id, existing_memory_id,
      created_at, updated_at
    )
    SELECT
      'memory_reconciliation_' || md5(
        candidate.tenant_id || ':' || candidate.id
      ),
      candidate.tenant_id,
      candidate.owner_actor_id,
      CASE WHEN existing.id IS NULL
        THEN 'confirmation'
        ELSE 'contradiction'
      END,
      'pending',
      NULL,
      'legacy_candidate',
      candidate.id,
      existing.id,
      candidate.created_at,
      candidate.updated_at
    FROM omni_memories candidate
    LEFT JOIN omni_memories existing
      ON existing.tenant_id = candidate.tenant_id
     AND existing.id = candidate.contradiction_of_id
     AND existing.claim_status <> 'forgotten'
     AND existing.owner_actor_id IS NOT DISTINCT FROM candidate.owner_actor_id
    WHERE candidate.claim_status = 'candidate'
      AND NOT omni_memory_ids_have_deletion_barrier(
        candidate.tenant_id,
        ARRAY[candidate.id]
      )
    ON CONFLICT (tenant_id, candidate_memory_id) DO NOTHING
  `;
  await sql`
    INSERT INTO omni_events (
      id, stream_id, type, tenant_id, actor_id, payload,
      causation_id, correlation_id, at
    )
    SELECT
      'memory_reconciliation_backfill_' || md5(
        review.tenant_id || ':' || review.id
      ),
      'memory-reconciliation:' || review.id,
      'memory.reconciliation.backfilled',
      review.tenant_id,
      COALESCE(review.owner_actor_id, 'system'),
      jsonb_build_object(
        'schemaVersion', 1,
        'reviewId', review.id,
        'kind', review.kind,
        'candidateMemoryId', review.candidate_memory_id,
        'existingMemoryId', review.existing_memory_id,
        'detectionReason', review.detection_reason
      ),
      review.candidate_memory_id,
      'schema-migration:101',
      review.created_at
    FROM omni_memory_reconciliation_reviews review
    ON CONFLICT (id) DO NOTHING
  `;

  await ensureTenantIsolationPolicies(sql);
  await sql`
    ALTER TABLE omni_memory_reconciliation_reviews
    ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_reconciliation_reviews
    FORCE ROW LEVEL SECURITY
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_reconciliation_actor_scope
    ON omni_memory_reconciliation_reviews
  `;
  await sql`
    CREATE POLICY omni_memory_reconciliation_actor_scope
    ON omni_memory_reconciliation_reviews
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR owner_actor_id IS NULL
      OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        owner_actor_id
      )
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR owner_actor_id IS NULL
      OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        owner_actor_id
      )
    )
  `;
  await sql`REVOKE ALL ON TABLE omni_memory_reconciliation_reviews FROM PUBLIC`;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_memories candidate
        WHERE candidate.claim_status = 'candidate'
          AND NOT omni_memory_ids_have_deletion_barrier(
            candidate.tenant_id,
            ARRAY[candidate.id]
          )
          AND NOT EXISTS (
            SELECT 1
            FROM omni_memory_reconciliation_reviews review
            WHERE review.tenant_id = candidate.tenant_id
              AND review.candidate_memory_id = candidate.id
          )
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_memory_reconciliation_reviews'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_memory_reconciliation_reviews'::regclass
          AND polname = 'omni_memory_reconciliation_actor_scope'
          AND NOT polpermissive
      ) THEN
        RAISE EXCEPTION 'Memory reconciliation inbox boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureMemoryLifecycleMaintenanceV1(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_memories
    DROP CONSTRAINT IF EXISTS omni_memories_tier_policy_check
  `;
  await sql`
    ALTER TABLE omni_memories
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
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_tier_policy_check
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_lifecycle_states (
      memory_id TEXT PRIMARY KEY REFERENCES omni_memories(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      access_contract_version SMALLINT NOT NULL DEFAULT 0,
      owner_actor_id TEXT,
      policy_version SMALLINT NOT NULL DEFAULT 1,
      pinned_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      archive_reason TEXT,
      duplicate_of_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (access_contract_version IN (0, 1)),
      CHECK (
        (access_contract_version = 0 AND owner_actor_id IS NULL)
        OR (access_contract_version = 1 AND omni_source_contract_id_is_valid(owner_actor_id))
      ),
      CHECK (policy_version = 1),
      CHECK (pinned_at IS NULL OR archived_at IS NULL),
      CHECK (
        (archived_at IS NULL AND archive_reason IS NULL AND duplicate_of_memory_id IS NULL)
        OR (
          archived_at IS NOT NULL
          AND archive_reason IN ('manual', 'exact_duplicate', 'retention_expired')
          AND (
            (archive_reason = 'exact_duplicate' AND duplicate_of_memory_id IS NOT NULL)
            OR (archive_reason <> 'exact_duplicate' AND duplicate_of_memory_id IS NULL)
          )
        )
      ),
      CHECK (duplicate_of_memory_id IS NULL OR duplicate_of_memory_id <> memory_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_promotion_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      access_contract_version SMALLINT NOT NULL DEFAULT 0,
      owner_actor_id TEXT,
      policy_version SMALLINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      source_memory_ids TEXT[] NOT NULL,
      canonical_memory_id TEXT NOT NULL REFERENCES omni_memories(id) ON DELETE CASCADE,
      source_claim_sha256 TEXT NOT NULL,
      target_tier TEXT NOT NULL DEFAULT 'procedural',
      promoted_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (access_contract_version IN (0, 1)),
      CHECK (
        (access_contract_version = 0 AND owner_actor_id IS NULL)
        OR (access_contract_version = 1 AND omni_source_contract_id_is_valid(owner_actor_id))
      ),
      CHECK (policy_version = 1),
      CHECK (target_tier = 'procedural'),
      CHECK (source_claim_sha256 ~ '^[0-9a-f]{64}$'),
      CHECK (
        (status = 'pending' AND decision IS NULL AND promoted_memory_id IS NULL AND resolved_at IS NULL)
        OR (
          status = 'resolved'
          AND decision IN ('promote', 'dismiss')
          AND resolved_at IS NOT NULL
          AND (
            (decision = 'promote' AND promoted_memory_id IS NOT NULL)
            OR (decision = 'dismiss' AND promoted_memory_id IS NULL)
          )
        )
      )
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_lifecycle_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      source_memory public.omni_memories%ROWTYPE;
      canonical_memory public.omni_memories%ROWTYPE;
    BEGIN
      SELECT * INTO source_memory
      FROM public.omni_memories memory
      WHERE memory.id = NEW.memory_id
        AND memory.tenant_id = NEW.tenant_id
        AND memory.claim_status <> 'forgotten';
      IF NOT FOUND
        OR source_memory.access_contract_version <> NEW.access_contract_version
        OR source_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR public.omni_memory_ids_have_deletion_barrier(
          NEW.tenant_id,
          ARRAY[NEW.memory_id]
        )
      THEN
        RAISE EXCEPTION 'Memory lifecycle source boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.archive_reason = 'exact_duplicate' THEN
        SELECT * INTO canonical_memory
        FROM public.omni_memories memory
        WHERE memory.id = NEW.duplicate_of_memory_id
          AND memory.tenant_id = NEW.tenant_id
          AND memory.claim_status = 'active';
        IF NOT FOUND
          OR canonical_memory.access_contract_version <> NEW.access_contract_version
          OR canonical_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
          OR canonical_memory.type <> source_memory.type
          OR canonical_memory.tier <> source_memory.tier
          OR canonical_memory.scope <> source_memory.scope
          OR canonical_memory.tags <> source_memory.tags
          OR canonical_memory.valid_from IS DISTINCT FROM source_memory.valid_from
          OR canonical_memory.valid_to IS DISTINCT FROM source_memory.valid_to
          OR canonical_memory.access_scope_sha256 IS DISTINCT FROM source_memory.access_scope_sha256
          OR regexp_replace(lower(btrim(canonical_memory.title)), '\\s+', ' ', 'g')
            <> regexp_replace(lower(btrim(source_memory.title)), '\\s+', ' ', 'g')
          OR regexp_replace(lower(btrim(canonical_memory.content)), '\\s+', ' ', 'g')
            <> regexp_replace(lower(btrim(source_memory.content)), '\\s+', ' ', 'g')
          OR public.omni_memory_ids_have_deletion_barrier(
            NEW.tenant_id,
            ARRAY[NEW.duplicate_of_memory_id]
          )
        THEN
          RAISE EXCEPTION 'Exact-duplicate archive boundary is invalid'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND ROW(
        OLD.memory_id, OLD.tenant_id, OLD.access_contract_version,
        OLD.owner_actor_id, OLD.policy_version, OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.memory_id, NEW.tenant_id, NEW.access_contract_version,
        NEW.owner_actor_id, NEW.policy_version, NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Memory lifecycle identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_memory_lifecycle_state()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_lifecycle_validate
    ON omni_memory_lifecycle_states
  `;
  await sql`
    CREATE TRIGGER omni_memory_lifecycle_validate
    BEFORE INSERT OR UPDATE ON omni_memory_lifecycle_states
    FOR EACH ROW EXECUTE FUNCTION omni_validate_memory_lifecycle_state()
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_promotion_review()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      canonical_memory public.omni_memories%ROWTYPE;
      source_count INTEGER;
      occurrence_count INTEGER;
      promoted_count INTEGER;
    BEGIN
      IF NOT public.omni_source_id_array_is_canonical(NEW.source_memory_ids, 64)
        OR cardinality(NEW.source_memory_ids) < 2
        OR NOT (NEW.canonical_memory_id = ANY(NEW.source_memory_ids))
      THEN
        RAISE EXCEPTION 'Memory promotion source ids are invalid'
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO canonical_memory
      FROM public.omni_memories memory
      WHERE memory.id = NEW.canonical_memory_id
        AND memory.tenant_id = NEW.tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Memory promotion canonical source is missing'
          USING ERRCODE = '23503';
      END IF;
      SELECT COUNT(*), COUNT(DISTINCT md5(
        memory.source || ':' || array_to_string(memory.evidence_refs, E'\\x1f')
      ))
      INTO source_count, occurrence_count
      FROM public.omni_memories memory
      WHERE memory.tenant_id = NEW.tenant_id
        AND memory.id = ANY(NEW.source_memory_ids)
        AND memory.claim_status = 'active'
        AND memory.tier = 'episodic'
        AND memory.formation_reason IN (
          'explicit_user_request', 'canonical_source_observation', 'verified_effect'
        )
        AND memory.confidence >= 0.8
        AND cardinality(memory.evidence_refs) > 0
        AND memory.access_contract_version = NEW.access_contract_version
        AND memory.owner_actor_id IS NOT DISTINCT FROM NEW.owner_actor_id
        AND memory.type = canonical_memory.type
        AND memory.scope = canonical_memory.scope
        AND memory.tags = canonical_memory.tags
        AND memory.valid_from IS NOT DISTINCT FROM canonical_memory.valid_from
        AND memory.valid_to IS NOT DISTINCT FROM canonical_memory.valid_to
        AND memory.access_scope_sha256 IS NOT DISTINCT FROM canonical_memory.access_scope_sha256
        AND regexp_replace(lower(btrim(memory.title)), '\\s+', ' ', 'g')
          = regexp_replace(lower(btrim(canonical_memory.title)), '\\s+', ' ', 'g')
        AND regexp_replace(lower(btrim(memory.content)), '\\s+', ' ', 'g')
          = regexp_replace(lower(btrim(canonical_memory.content)), '\\s+', ' ', 'g');
      IF source_count <> cardinality(NEW.source_memory_ids)
        OR occurrence_count < 2
        OR canonical_memory.access_contract_version <> NEW.access_contract_version
        OR canonical_memory.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR public.omni_memory_ids_have_deletion_barrier(
          NEW.tenant_id,
          NEW.source_memory_ids
        )
      THEN
        RAISE EXCEPTION 'Memory promotion evidence boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.promoted_memory_id IS NOT NULL THEN
        SELECT COUNT(*) INTO promoted_count
        FROM public.omni_memories memory
        WHERE memory.id = NEW.promoted_memory_id
          AND memory.tenant_id = NEW.tenant_id
          AND memory.claim_status = 'active'
          AND memory.tier = 'procedural'
          AND memory.formation_reason = 'maintenance_promotion'
          AND memory.promoted_from_tier = 'episodic'
          AND memory.access_contract_version = NEW.access_contract_version
          AND memory.owner_actor_id IS NOT DISTINCT FROM NEW.owner_actor_id
          AND NEW.source_memory_ids <@ ARRAY(
            SELECT substring(reference FROM 8)
            FROM unnest(memory.evidence_refs) reference
            WHERE reference LIKE 'memory:%'
          );
        IF promoted_count <> 1 THEN
          RAISE EXCEPTION 'Promoted memory lineage is invalid'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF ROW(
          OLD.id, OLD.tenant_id, OLD.access_contract_version,
          OLD.owner_actor_id, OLD.policy_version, OLD.source_memory_ids,
          OLD.canonical_memory_id, OLD.source_claim_sha256,
          OLD.target_tier, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.id, NEW.tenant_id, NEW.access_contract_version,
          NEW.owner_actor_id, NEW.policy_version, NEW.source_memory_ids,
          NEW.canonical_memory_id, NEW.source_claim_sha256,
          NEW.target_tier, NEW.created_at
        ) OR OLD.status = 'resolved' AND ROW(
          OLD.status, OLD.decision, OLD.promoted_memory_id, OLD.resolved_at
        ) IS DISTINCT FROM ROW(
          NEW.status, NEW.decision, NEW.promoted_memory_id, NEW.resolved_at
        ) THEN
          RAISE EXCEPTION 'Memory promotion review is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_memory_promotion_review()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_promotion_review_validate
    ON omni_memory_promotion_reviews
  `;
  await sql`
    CREATE TRIGGER omni_memory_promotion_review_validate
    BEFORE INSERT OR UPDATE ON omni_memory_promotion_reviews
    FOR EACH ROW EXECUTE FUNCTION omni_validate_memory_promotion_review()
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_scrub_memory_lifecycle_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      DELETE FROM public.omni_memory_lifecycle_states lifecycle
      WHERE lifecycle.tenant_id = OLD.tenant_id
        AND lifecycle.memory_id = OLD.id;
      DELETE FROM public.omni_memory_promotion_reviews review
      WHERE review.tenant_id = OLD.tenant_id
        AND (
          OLD.id = ANY(review.source_memory_ids)
          OR review.promoted_memory_id = OLD.id
        );
      RETURN OLD;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_scrub_memory_lifecycle_lineage()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_scrub_lifecycle_on_forget
    ON omni_memories
  `;
  await sql`
    CREATE TRIGGER omni_memories_scrub_lifecycle_on_forget
    AFTER UPDATE OF claim_status ON omni_memories
    FOR EACH ROW
    WHEN (NEW.claim_status = 'forgotten' AND OLD.claim_status <> 'forgotten')
    EXECUTE FUNCTION omni_scrub_memory_lifecycle_lineage()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_scrub_lifecycle_on_delete
    ON omni_memories
  `;
  await sql`
    CREATE TRIGGER omni_memories_scrub_lifecycle_on_delete
    AFTER DELETE ON omni_memories
    FOR EACH ROW EXECUTE FUNCTION omni_scrub_memory_lifecycle_lineage()
  `;

  for (const tableName of [
    "omni_memory_lifecycle_states",
    "omni_memory_promotion_reviews",
  ]) {
    await sql.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
    await sql.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);
    await sql.query(`DROP POLICY IF EXISTS ${tableName}_actor_scope ON ${tableName}`);
    await sql.query(`
      CREATE POLICY ${tableName}_actor_scope
      ON ${tableName}
      AS RESTRICTIVE
      FOR ALL
      USING (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND omni_user_private_memory_scope_v1_allows_validated(
            (SELECT omni_current_memory_access_scope_v1()),
            tenant_id,
            owner_actor_id,
            ARRAY[
              'memory.export.v1', 'memory.forget.v1',
              'memory.maintenance.v1', 'memory.read.v1', 'memory.retrieve.v1'
            ]::TEXT[]
          )
        )
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR (
          access_contract_version = 0
          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL
        )
        OR (
          access_contract_version = 1
          AND omni_user_private_memory_scope_v1_allows_validated(
            (SELECT omni_current_memory_access_scope_v1()),
            tenant_id,
            owner_actor_id,
            ARRAY[
              'memory.export.v1', 'memory.forget.v1',
              'memory.maintenance.v1', 'memory.read.v1', 'memory.retrieve.v1'
            ]::TEXT[]
          )
        )
      )
    `);
    await sql.query(`DROP POLICY IF EXISTS ${tableName}_mutation_purpose ON ${tableName}`);
    await sql.query(`DROP POLICY IF EXISTS ${tableName}_insert_purpose ON ${tableName}`);
    await sql.query(`DROP POLICY IF EXISTS ${tableName}_update_purpose ON ${tableName}`);
    await sql.query(`DROP POLICY IF EXISTS ${tableName}_delete_purpose ON ${tableName}`);
    await sql.query(`
      CREATE POLICY ${tableName}_insert_purpose
      ON ${tableName}
      AS RESTRICTIVE
      FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR access_contract_version = 0
        OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
          = 'memory.maintenance.v1'
      )
    `);
    await sql.query(`
      CREATE POLICY ${tableName}_update_purpose
      ON ${tableName}
      AS RESTRICTIVE
      FOR UPDATE
      USING (
        omni_system_scope_enabled()
        OR access_contract_version = 0
        OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
          = 'memory.maintenance.v1'
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR access_contract_version = 0
        OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
          = 'memory.maintenance.v1'
      )
    `);
    await sql.query(`
      CREATE POLICY ${tableName}_delete_purpose
      ON ${tableName}
      AS RESTRICTIVE
      FOR DELETE
      USING (
        omni_system_scope_enabled()
        OR access_contract_version = 0
        OR (SELECT omni_current_memory_access_scope_v1()) ->> 'purposeId'
          = 'memory.maintenance.v1'
      )
    `);
  }

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_lifecycle_tenant_archive_idx
    ON omni_memory_lifecycle_states (tenant_id, archived_at DESC, updated_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_lifecycle_tenant_pin_idx
    ON omni_memory_lifecycle_states (tenant_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_lifecycle_duplicate_idx
    ON omni_memory_lifecycle_states (tenant_id, duplicate_of_memory_id)
    WHERE duplicate_of_memory_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_promotion_review_status_idx
    ON omni_memory_promotion_reviews (tenant_id, status, updated_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_promotion_review_actor_idx
    ON omni_memory_promotion_reviews (tenant_id, owner_actor_id, status, updated_at DESC)
    WHERE access_contract_version = 1
  `;
}

export async function ensureEvidenceBasedMemoryFormation(sql: SqlClient) {
  await sql`DROP TABLE IF EXISTS pg_temp.omni_response_memory_quarantine`;
  await sql`
    CREATE TEMP TABLE omni_response_memory_quarantine
    ON COMMIT DROP
    AS
    SELECT tenant_id, id
    FROM omni_memories
    WHERE claim_status = 'active'
      AND (
        (
          source IN ('agent', 'consolidator')
          AND asserted_by = 'agent'
        )
        OR (
          source = 'workflow'
          AND type = 'episode'
        )
      )
  `;
  await sql`
    INSERT INTO omni_events (
      id, stream_id, type, tenant_id, actor_id, payload,
      causation_id, correlation_id, at
    )
    SELECT
      'memory_response_quarantine_' || md5(
        quarantine.tenant_id || ':' || quarantine.id
      ),
      'memory:' || quarantine.id,
      'memory.response_derived.quarantined',
      quarantine.tenant_id,
      'system',
      jsonb_build_object(
        'schemaVersion', 1,
        'memoryId', quarantine.id,
        'previousClaimStatus', 'active',
        'claimStatus', 'candidate',
        'reasonCode', 'unsupported_response_derived_claim'
      ),
      quarantine.id,
      'schema-migration:83',
      NOW()
    FROM omni_response_memory_quarantine quarantine
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE omni_memories memory
    SET claim_status = 'candidate',
        updated_at = NOW()
    FROM omni_response_memory_quarantine quarantine
    WHERE memory.tenant_id = quarantine.tenant_id
      AND memory.id = quarantine.id
  `;
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    WHERE EXISTS (
      SELECT 1
      FROM omni_response_memory_quarantine quarantine
      WHERE quarantine.tenant_id = edge.tenant_id
        AND quarantine.id = ANY(edge.memory_ids)
    )
    OR EXISTS (
      SELECT 1
      FROM omni_memory_graph_nodes endpoint
      JOIN omni_response_memory_quarantine quarantine
        ON quarantine.tenant_id = endpoint.tenant_id
       AND quarantine.id = ANY(endpoint.memory_ids)
      WHERE endpoint.tenant_id = edge.tenant_id
        AND endpoint.id IN (edge.source_node_id, edge.target_node_id)
    )
  `;
  await sql`
    DELETE FROM omni_memory_graph_nodes node
    WHERE EXISTS (
      SELECT 1
      FROM omni_response_memory_quarantine quarantine
      WHERE quarantine.tenant_id = node.tenant_id
        AND quarantine.id = ANY(node.memory_ids)
    )
  `;
  await sql`
    DELETE FROM omni_daily_briefs brief
    WHERE EXISTS (
      SELECT 1
      FROM omni_response_memory_quarantine quarantine
      WHERE quarantine.tenant_id = brief.tenant_id
        AND quarantine.id = ANY(brief.memory_ids)
    )
  `;
  await sql`
    INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
      tenant_id, requested_at, attempts, last_error, updated_at, generation
    )
    SELECT DISTINCT
      quarantine.tenant_id, NOW(), 0, NULL, NOW(), 1
    FROM omni_response_memory_quarantine quarantine
    ON CONFLICT (tenant_id) DO UPDATE SET
      requested_at = NOW(),
      attempts = 0,
      last_error = NULL,
      updated_at = NOW(),
      generation = rebuild.generation + 1
  `;
}


export async function ensureMemoryGraphRebuildQueue(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_graph_rebuild_queue (
      tenant_id TEXT PRIMARY KEY,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_graph_rebuild_queue_requested_idx
    ON omni_memory_graph_rebuild_queue (requested_at ASC)
  `;
}

export async function ensureMemoryGraphRebuildGenerationLeases(sql: SqlClient) {
  await ensureMemoryGraphRebuildQueue(sql);
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS generation BIGINT
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS lease_owner TEXT
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
  `;
  await sql`
    UPDATE omni_memory_graph_rebuild_queue
    SET generation = 1
    WHERE generation IS NULL OR generation < 1
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ALTER COLUMN generation SET DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ALTER COLUMN generation SET NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_graph_rebuild_queue_lease_idx
    ON omni_memory_graph_rebuild_queue (lease_expires_at, requested_at)
  `;
}

export async function reconcileLegacyMemoryGraphOwnership(sql: SqlClient) {
  // Legacy graph rows could combine evidence from more than one tenant before
  // graph IDs and slugs were tenant-namespaced. Reassigning those snapshots
  // would preserve cross-tenant summaries, so discard every legacy projection
  // and durably queue a clean per-tenant rebuild from authoritative memories.
  await sql`
    INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
      tenant_id, requested_at, attempts, last_error, updated_at, generation
    )
    SELECT tenant_id, NOW(), 0, NULL, NOW(), 1
    FROM (
      SELECT tenant_id
      FROM omni_memories
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      UNION
      SELECT tenant_id
      FROM omni_retrieval_traces
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
    ) tenants
    ON CONFLICT (tenant_id) DO UPDATE SET
      requested_at = NOW(),
      attempts = 0,
      last_error = NULL,
      updated_at = NOW(),
      generation = rebuild.generation + 1
  `;
  await sql`DELETE FROM omni_memory_graph_edges`;
  await sql`DELETE FROM omni_memory_graph_nodes`;
}

export async function ensureMemoryDeletionBarriers(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_deletion_receipts (
      id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      contract_kind TEXT NOT NULL DEFAULT 'memory_deletion',
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      attribution_kind TEXT NOT NULL,
      initiating_actor_id TEXT,
      executing_principal_type TEXT,
      executing_principal_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      purpose TEXT,
      execution_scope JSONB,
      execution_scope_sha256 TEXT,
      receipt_sha256 TEXT,
      delete_reason TEXT NOT NULL,
      descendant_memory_ids TEXT[] NOT NULL DEFAULT '{}',
      retrieval_trace_ids TEXT[] NOT NULL DEFAULT '{}',
      graph_node_ids TEXT[] NOT NULL DEFAULT '{}',
      graph_edge_ids TEXT[] NOT NULL DEFAULT '{}',
      descendant_memory_count INTEGER NOT NULL DEFAULT 0,
      retrieval_trace_count INTEGER NOT NULL DEFAULT 0,
      graph_node_count INTEGER NOT NULL DEFAULT 0,
      graph_edge_count INTEGER NOT NULL DEFAULT 0,
      descendant_manifest_sha256 TEXT,
      forgotten_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_deletion_receipts_pkey
        PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_memory_deletion_receipts_memory_key
        UNIQUE (tenant_id, memory_id),
      CONSTRAINT omni_memory_deletion_receipts_hash_key
        UNIQUE (tenant_id, receipt_sha256),
      CONSTRAINT omni_memory_deletion_receipts_contract_check CHECK (
        schema_version = 1
        AND contract_kind = 'memory_deletion'
        AND char_length(id) BETWEEN 1 AND 240
        AND char_length(tenant_id) BETWEEN 1 AND 240
        AND char_length(memory_id) BETWEEN 1 AND 240
      ),
      CONSTRAINT omni_memory_deletion_receipts_counts_check CHECK (
        descendant_memory_count = cardinality(descendant_memory_ids)
        AND retrieval_trace_count = cardinality(retrieval_trace_ids)
        AND graph_node_count = cardinality(graph_node_ids)
        AND graph_edge_count = cardinality(graph_edge_ids)
      ),
      CONSTRAINT omni_memory_deletion_receipts_attribution_check CHECK (
        (
          attribution_kind = 'scope_bound'
          AND initiating_actor_id IS NOT NULL
          AND initiating_actor_id <> ''
          AND executing_principal_type IS NOT NULL
          AND executing_principal_type IN ('user', 'agent', 'system')
          AND correlation_id IS NOT NULL
          AND correlation_id <> ''
          AND purpose IS NOT NULL
          AND purpose <> ''
          AND execution_scope IS NOT NULL
          AND jsonb_typeof(execution_scope) = 'object'
          AND execution_scope ->> 'version' = '1'
          AND execution_scope ->> 'tenantId' = tenant_id
          AND execution_scope ->> 'initiatingActorId' = initiating_actor_id
          AND execution_scope ->> 'executingPrincipalType' =
            executing_principal_type
          AND (execution_scope ->> 'executingPrincipalId')
            IS NOT DISTINCT FROM executing_principal_id
          AND execution_scope ->> 'correlationId' = correlation_id
          AND (execution_scope ->> 'causationId')
            IS NOT DISTINCT FROM causation_id
          AND execution_scope ->> 'purpose' = purpose
          AND execution_scope_sha256 IS NOT NULL
          AND execution_scope_sha256 ~ '^[0-9a-f]{64}$'
          AND receipt_sha256 IS NOT NULL
          AND receipt_sha256 ~ '^[0-9a-f]{64}$'
          AND descendant_manifest_sha256 IS NOT NULL
          AND descendant_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND delete_reason = 'explicit_forget'
        )
        OR (
          attribution_kind = 'legacy_unattributed'
          AND initiating_actor_id IS NULL
          AND executing_principal_type IS NULL
          AND executing_principal_id IS NULL
          AND correlation_id IS NULL
          AND causation_id IS NULL
          AND purpose IS NULL
          AND execution_scope IS NULL
          AND execution_scope_sha256 IS NULL
          AND receipt_sha256 IS NULL
          AND descendant_manifest_sha256 IS NULL
          AND delete_reason = 'legacy_unattributed'
        )
      )
    )
  `;

  await sql`
    ALTER TABLE omni_retrieval_traces
    ADD COLUMN IF NOT EXISTS memory_ids TEXT[]
  `;
  // Re-running this idempotent migration must be able to recompute historical
  // closure. DDL is transactional, so the committed barrier is never absent.
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memories
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_memory_lineage
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_validate_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_graph_lock
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_memory_lineage
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_validate_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_graph_lock
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_memory_lineage
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_validate_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_graph_lock
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_graph_lock
    ON omni_memories
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_deletion_barrier
    ON omni_memories
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_validate_canonical_forget
    ON omni_memories
  `;

  // Receipts require a stable forget timestamp. Establish only that field
  // before computing legacy lineage so outbound references remain available
  // to the conservative descendant manifest.
  await sql`
    UPDATE omni_memories
    SET forgotten_at = COALESCE(updated_at, created_at, NOW()),
        updated_at = COALESCE(updated_at, created_at, NOW())
    WHERE claim_status = 'forgotten'
      AND forgotten_at IS NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_direct_trace_memory_ids(trace_results JSONB)
    RETURNS TEXT[]
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT (result ->> 'id') COLLATE "C"
          ORDER BY (result ->> 'id') COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(trace_results) = 'array' THEN trace_results
          ELSE '[]'::JSONB
        END
      ) result
      WHERE result ->> 'kind' = 'memory'
        AND NULLIF(BTRIM(result ->> 'id'), '') IS NOT NULL
    $function$
  `;

  // Existing lineage must not cross a tenant boundary. Missing legacy targets
  // are possible because the old retention sweep physically deleted memories;
  // clear only those dangling pointers before the permanent barrier is active.
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_memories child
        CROSS JOIN LATERAL (
          SELECT child.supersedes_id AS memory_id
          UNION ALL
          SELECT child.contradiction_of_id AS memory_id
          UNION ALL
          SELECT substring(evidence_ref FROM 8) AS memory_id
          FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[])) evidence_ref
          WHERE evidence_ref LIKE 'memory:%'
            AND char_length(evidence_ref) > 7
        ) reference
        WHERE reference.memory_id IS NOT NULL
          AND reference.memory_id <> child.id
          AND EXISTS (
            SELECT 1
            FROM omni_memories target
            WHERE target.id = reference.memory_id
              AND target.tenant_id <> child.tenant_id
          )
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant memory lineage'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_retrieval_traces trace
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(trace.results) = 'array' THEN trace.results
            ELSE '[]'::JSONB
          END
        ) result
        JOIN omni_memories memory ON memory.id = result ->> 'id'
        WHERE result ->> 'kind' = 'memory'
          AND memory.tenant_id <> trace.tenant_id
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant trace lineage'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes node
        CROSS JOIN LATERAL unnest(node.memory_ids) memory_id
        JOIN omni_memories memory ON memory.id = memory_id
        WHERE memory.tenant_id <> node.tenant_id
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        CROSS JOIN LATERAL unnest(edge.memory_ids) memory_id
        JOIN omni_memories memory ON memory.id = memory_id
        WHERE memory.tenant_id <> edge.tenant_id
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        WHERE EXISTS (
          SELECT 1
          FROM omni_memory_graph_nodes source_node
          WHERE source_node.id = edge.source_node_id
            AND source_node.tenant_id <> edge.tenant_id
        ) OR EXISTS (
          SELECT 1
          FROM omni_memory_graph_nodes target_node
          WHERE target_node.id = edge.target_node_id
            AND target_node.tenant_id <> edge.tenant_id
        )
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant graph lineage'
          USING ERRCODE = '23514';
      END IF;
    END
    $migration$
  `;

  // Older partial graph cleanup could leave an edge whose endpoint is gone.
  // Cross-tenant endpoints were rejected above; remove only globally missing
  // endpoint rows so deterministic rebuilds cannot collide with hidden debris.
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    WHERE NOT EXISTS (
      SELECT 1
      FROM omni_memory_graph_nodes source_node
      WHERE source_node.id = edge.source_node_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM omni_memory_graph_nodes target_node
      WHERE target_node.id = edge.target_node_id
    )
  `;

  await sql`
    UPDATE omni_memories child
    SET supersedes_id = CASE
          WHEN child.supersedes_id IS NULL
            OR child.supersedes_id = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = child.supersedes_id
            )
          THEN child.supersedes_id
          ELSE NULL
        END,
        contradiction_of_id = CASE
          WHEN child.contradiction_of_id IS NULL
            OR child.contradiction_of_id = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = child.contradiction_of_id
            )
          THEN child.contradiction_of_id
          ELSE NULL
        END,
        evidence_refs = ARRAY(
          SELECT evidence_ref
          FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[]))
            WITH ORDINALITY AS reference(evidence_ref, position)
          WHERE reference.evidence_ref NOT LIKE 'memory:%'
            OR char_length(reference.evidence_ref) <= 7
            OR substring(reference.evidence_ref FROM 8) = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = substring(reference.evidence_ref FROM 8)
            )
          ORDER BY reference.position
        )
    WHERE (
      child.supersedes_id IS NOT NULL
      AND child.supersedes_id <> child.id
      AND NOT EXISTS (
        SELECT 1
        FROM omni_memories target
        WHERE target.tenant_id = child.tenant_id
          AND target.id = child.supersedes_id
      )
    ) OR (
      child.contradiction_of_id IS NOT NULL
      AND child.contradiction_of_id <> child.id
      AND NOT EXISTS (
        SELECT 1
        FROM omni_memories target
        WHERE target.tenant_id = child.tenant_id
          AND target.id = child.contradiction_of_id
      )
    ) OR EXISTS (
      SELECT 1
      FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[])) evidence_ref
      WHERE evidence_ref LIKE 'memory:%'
        AND char_length(evidence_ref) > 7
        AND substring(evidence_ref FROM 8) <> child.id
        AND NOT EXISTS (
          SELECT 1
          FROM omni_memories target
          WHERE target.tenant_id = child.tenant_id
            AND target.id = substring(evidence_ref FROM 8)
        )
    )
  `;

  // Seed direct trace lineage. Malformed results and unresolved graph result
  // references conservatively inherit every known memory id in their tenant.
  await sql`
    UPDATE omni_retrieval_traces trace
    SET memory_ids = CASE
      WHEN jsonb_typeof(trace.results) <> 'array'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(trace.results) = 'array'
                THEN trace.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE jsonb_typeof(result) <> 'object'
            OR COALESCE(result ->> 'kind', '') NOT IN (
              'memory', 'knowledge', 'graph'
            )
            OR NULLIF(BTRIM(result ->> 'id'), '') IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(trace.results) = 'array'
                THEN trace.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE result ->> 'kind' = 'graph'
            AND NOT EXISTS (
              SELECT 1
              FROM omni_memory_graph_nodes node
              WHERE node.id = result ->> 'id'
                AND node.tenant_id = trace.tenant_id
            )
        )
      THEN ARRAY(
        SELECT lineage.memory_id
        FROM (
          SELECT memory.id COLLATE "C" AS memory_id
          FROM omni_memories memory
          WHERE memory.tenant_id = trace.tenant_id
          UNION
          SELECT unnest(
            omni_direct_trace_memory_ids(trace.results)
          ) COLLATE "C"
        ) lineage
        ORDER BY lineage.memory_id COLLATE "C"
      )
      ELSE omni_direct_trace_memory_ids(trace.results)
    END
  `;

  // Materialize the trace/graph closure to a fixed point. Existing graph
  // rows can derive from traces and traces can cite graph nodes, so one pass
  // is insufficient. Missing legacy trace references conservatively taint a
  // graph row with every known memory id in its tenant.
  await sql`
    DO $migration$
    DECLARE
      changed_rows INTEGER;
      total_changed INTEGER;
      pass INTEGER := 0;
    BEGIN
      LOOP
        pass := pass + 1;
        total_changed := 0;

        WITH closure AS (
          SELECT trace.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_retrieval_traces trace
          CROSS JOIN LATERAL (
            SELECT unnest(COALESCE(trace.memory_ids, '{}'::TEXT[])) AS memory_id
            UNION ALL
            SELECT unnest(node.memory_ids) AS memory_id
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(trace.results) = 'array'
                  THEN trace.results
                ELSE '[]'::JSONB
              END
            ) result
            JOIN omni_memory_graph_nodes node
              ON node.id = result ->> 'id'
             AND node.tenant_id = trace.tenant_id
            WHERE result ->> 'kind' = 'graph'
          ) lineage
          GROUP BY trace.id
        )
        UPDATE omni_retrieval_traces trace
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE trace.id = closure.id
          AND trace.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        WITH closure AS (
          SELECT node.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_memory_graph_nodes node
          CROSS JOIN LATERAL (
            SELECT unnest(node.memory_ids) AS memory_id
            UNION ALL
            SELECT unnest(trace.memory_ids) AS memory_id
            FROM omni_retrieval_traces trace
            WHERE trace.tenant_id = node.tenant_id
              AND trace.id = ANY(node.trace_ids)
            UNION ALL
            SELECT memory.id AS memory_id
            FROM omni_memories memory
            WHERE memory.tenant_id = node.tenant_id
              AND EXISTS (
                SELECT 1
                FROM unnest(node.trace_ids) trace_id
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM omni_retrieval_traces trace
                  WHERE trace.id = trace_id
                    AND trace.tenant_id = node.tenant_id
                )
              )
          ) lineage
          GROUP BY node.id
        )
        UPDATE omni_memory_graph_nodes node
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE node.id = closure.id
          AND node.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        WITH closure AS (
          SELECT edge.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_memory_graph_edges edge
          CROSS JOIN LATERAL (
            SELECT unnest(edge.memory_ids) AS memory_id
            UNION ALL
            SELECT unnest(trace.memory_ids) AS memory_id
            FROM omni_retrieval_traces trace
            WHERE trace.tenant_id = edge.tenant_id
              AND trace.id = ANY(edge.trace_ids)
            UNION ALL
            SELECT unnest(endpoint.memory_ids) AS memory_id
            FROM omni_memory_graph_nodes endpoint
            WHERE endpoint.tenant_id = edge.tenant_id
              AND endpoint.id = ANY(
                ARRAY[edge.source_node_id, edge.target_node_id]
              )
            UNION ALL
            SELECT memory.id AS memory_id
            FROM omni_memories memory
            WHERE memory.tenant_id = edge.tenant_id
              AND EXISTS (
                SELECT 1
                FROM unnest(edge.trace_ids) trace_id
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM omni_retrieval_traces trace
                  WHERE trace.id = trace_id
                    AND trace.tenant_id = edge.tenant_id
                )
              )
          ) lineage
          GROUP BY edge.id
        )
        UPDATE omni_memory_graph_edges edge
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE edge.id = closure.id
          AND edge.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        EXIT WHEN total_changed = 0;
        IF pass >= 128 THEN
          RAISE EXCEPTION
            'Memory deletion lineage closure did not converge after 128 passes'
            USING ERRCODE = '54000';
        END IF;
      END LOOP;
    END
    $migration$
  `;

  await sql`
    UPDATE omni_retrieval_traces
    SET memory_ids = '{}'::TEXT[]
    WHERE memory_ids IS NULL
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces
    ALTER COLUMN memory_ids SET DEFAULT '{}'::TEXT[]
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces
    ALTER COLUMN memory_ids SET NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_retrieval_traces_memory_ids_idx
    ON omni_retrieval_traces USING GIN (memory_ids)
  `;

  // Existing forgotten rows predate execution-scope binding. Preserve that
  // fact explicitly while recording the conservative descendant manifest;
  // never synthesize an actor, scope, correlation id, or authenticated hash.
  await sql`
    WITH RECURSIVE lineage AS (
      SELECT root.tenant_id COLLATE "C" AS tenant_id,
             root.id COLLATE "C" AS root_memory_id,
             root.id COLLATE "C" AS current_memory_id
      FROM omni_memories root
      WHERE root.claim_status = 'forgotten'
      UNION
      SELECT lineage.tenant_id,
             lineage.root_memory_id,
             child.id
      FROM lineage
      JOIN omni_memories child
        ON child.tenant_id = lineage.tenant_id
       AND (
         child.supersedes_id = lineage.current_memory_id
         OR child.contradiction_of_id = lineage.current_memory_id
         OR ('memory:' || lineage.current_memory_id) = ANY(child.evidence_refs)
       )
    ),
    manifests AS (
      SELECT root.tenant_id,
             root.id AS memory_id,
             root.forgotten_at,
             ARRAY(
               SELECT descendant.current_memory_id
               FROM lineage descendant
               WHERE descendant.tenant_id = root.tenant_id
                 AND descendant.root_memory_id = root.id
                 AND descendant.current_memory_id <> root.id
               ORDER BY descendant.current_memory_id COLLATE "C"
             ) AS descendant_memory_ids,
             ARRAY(
               SELECT trace.id
               FROM omni_retrieval_traces trace
               WHERE trace.tenant_id = root.tenant_id
                 AND trace.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY trace.id COLLATE "C"
             ) AS retrieval_trace_ids,
             ARRAY(
               SELECT node.id
               FROM omni_memory_graph_nodes node
               WHERE node.tenant_id = root.tenant_id
                 AND node.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY node.id COLLATE "C"
             ) AS graph_node_ids,
             ARRAY(
               SELECT edge.id
               FROM omni_memory_graph_edges edge
               WHERE edge.tenant_id = root.tenant_id
                 AND edge.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY edge.id COLLATE "C"
             ) AS graph_edge_ids
      FROM omni_memories root
      WHERE root.claim_status = 'forgotten'
    )
    INSERT INTO omni_memory_deletion_receipts (
      id, schema_version, contract_kind, tenant_id, memory_id,
      attribution_kind, initiating_actor_id, executing_principal_type,
      executing_principal_id, correlation_id, causation_id, purpose,
      execution_scope, execution_scope_sha256, receipt_sha256, delete_reason,
      descendant_memory_ids, retrieval_trace_ids, graph_node_ids,
      graph_edge_ids, descendant_memory_count, retrieval_trace_count,
      graph_node_count, graph_edge_count, descendant_manifest_sha256,
      forgotten_at
    )
    SELECT 'legacy:' || md5(manifest.tenant_id || ':' || manifest.memory_id),
           1,
           'memory_deletion',
           manifest.tenant_id,
           manifest.memory_id,
           'legacy_unattributed',
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           'legacy_unattributed',
           manifest.descendant_memory_ids,
           manifest.retrieval_trace_ids,
           manifest.graph_node_ids,
           manifest.graph_edge_ids,
           cardinality(manifest.descendant_memory_ids),
           cardinality(manifest.retrieval_trace_ids),
           cardinality(manifest.graph_node_ids),
           cardinality(manifest.graph_edge_ids),
           NULL,
           manifest.forgotten_at
    FROM manifests manifest
    WHERE NOT EXISTS (
      SELECT 1
      FROM omni_memory_deletion_receipts receipt
      WHERE receipt.tenant_id = manifest.tenant_id
        AND receipt.memory_id = manifest.memory_id
    )
    ON CONFLICT (tenant_id, memory_id) DO NOTHING
  `;

  // Remove every derived row captured by a legacy receipt before clearing the
  // root's outbound references. Keeping these hidden rows would make later
  // deterministic graph upserts collide with an immutable deletion barrier.
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    USING omni_memory_deletion_receipts receipt
    WHERE edge.tenant_id = receipt.tenant_id
      AND edge.id = ANY(receipt.graph_edge_ids)
  `;
  await sql`
    DELETE FROM omni_memory_graph_nodes node
    USING omni_memory_deletion_receipts receipt
    WHERE node.tenant_id = receipt.tenant_id
      AND node.id = ANY(receipt.graph_node_ids)
  `;
  await sql`
    DELETE FROM omni_retrieval_traces trace
    USING omni_memory_deletion_receipts receipt
    WHERE trace.tenant_id = receipt.tenant_id
      AND trace.id = ANY(receipt.retrieval_trace_ids)
  `;
  await sql`
    INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
      tenant_id, requested_at, attempts, last_error, updated_at, generation
    )
    SELECT DISTINCT receipt.tenant_id, NOW(), 0, NULL, NOW(), 1
    FROM omni_memory_deletion_receipts receipt
    ON CONFLICT (tenant_id) DO UPDATE SET
      requested_at = NOW(),
      attempts = 0,
      last_error = NULL,
      updated_at = NOW(),
      generation = rebuild.generation + 1
  `;

  // Capture legacy lineage in the immutable receipt before clearing the
  // forgotten shell's outbound references, then enforce the same canonical
  // scrub required for newly governed forgets.
  await sql`
    UPDATE omni_memories
    SET title = '[forgotten]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[forgotten]',
        embedding = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        forgotten_at = COALESCE(forgotten_at, updated_at, created_at, NOW()),
        updated_at = COALESCE(forgotten_at, updated_at, created_at, NOW())
    WHERE claim_status = 'forgotten'
      AND (
        title <> '[forgotten]'
        OR content <> ''
        OR cardinality(tags) <> 0
        OR source <> '[forgotten]'
        OR embedding IS NOT NULL
        OR cardinality(evidence_refs) <> 0
        OR supersedes_id IS NOT NULL
        OR contradiction_of_id IS NOT NULL
        OR forgotten_at IS NULL
      )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND column_name = 'embedding_vector'
      ) THEN
        EXECUTE
          'UPDATE omni_memories SET embedding_vector = NULL ' ||
          'WHERE claim_status = ''forgotten'' AND embedding_vector IS NOT NULL';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_deletion_ids_are_canonical(ids TEXT[])
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT COALESCE(ids, '{}'::TEXT[]) = ARRAY(
        SELECT DISTINCT id COLLATE "C"
        FROM unnest(COALESCE(ids, '{}'::TEXT[])) id
        WHERE NULLIF(BTRIM(id), '') IS NOT NULL
        ORDER BY id COLLATE "C"
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_ids_have_deletion_barrier(
      row_tenant_id TEXT,
      row_memory_ids TEXT[]
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = row_tenant_id
          AND (
            ARRAY[receipt.memory_id] || receipt.descendant_memory_ids
          ) && COALESCE(row_memory_ids, '{}'::TEXT[])
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_immutable_memory_deletion_receipt()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory deletion receipts are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION
        'Memory rows are permanent shells; use the governed canonical forget path'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_lock_memory_graph_for_statement()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      active_tenant_id TEXT;
    BEGIN
      active_tenant_id := NULLIF(
        current_setting('omni.tenant_id', true),
        ''
      );
      IF active_tenant_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('memory-graph:' || active_tenant_id, 0)
        );
      ELSE
        -- Serialize every unscoped/system lock-set enumeration. Tenant rows can
        -- appear between statements, so a mutable full-set scan alone cannot
        -- establish a global A/B ordering across concurrent maintenance work.
        PERFORM pg_advisory_xact_lock(
          hashtextextended('memory-graph-lock-order:global', 0)
        );
        -- Owner/system maintenance may span tenants. Lock the existing tenant
        -- graph domains in canonical order before PostgreSQL acquires any row
        -- locks; this preserves graph->row ordering against explicit forgets.
        FOR active_tenant_id IN EXECUTE format(
          'SELECT DISTINCT tenant_id COLLATE "C" FROM %I.%I ' ||
          'WHERE tenant_id IS NOT NULL ' ||
          'ORDER BY tenant_id COLLATE "C"',
          TG_TABLE_SCHEMA,
          TG_TABLE_NAME
        )
        LOOP
          PERFORM pg_advisory_xact_lock(
            hashtextextended('memory-graph:' || active_tenant_id, 0)
          );
        END LOOP;
      END IF;
      RETURN NULL;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_deletion_receipt()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      memory omni_memories%ROWTYPE;
      expected_descendant_memory_ids TEXT[];
      blocked_memory_ids TEXT[];
      expected_retrieval_trace_ids TEXT[];
      expected_graph_node_ids TEXT[];
      expected_graph_edge_ids TEXT[];
      deleted_row_count INTEGER;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext('memory:' || NEW.memory_id)
      );

      IF EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.memory_id = NEW.memory_id
      ) THEN
        RETURN NEW;
      END IF;

      IF NEW.attribution_kind <> 'scope_bound' THEN
        RAISE EXCEPTION
          'Only scope-bound memory deletion receipts may be created after migration'
          USING ERRCODE = '23514';
      END IF;

      SELECT stored_memory.*
      INTO memory
      FROM omni_memories stored_memory
      WHERE stored_memory.tenant_id = NEW.tenant_id
        AND stored_memory.id = NEW.memory_id
      FOR KEY SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Memory deletion receipt target does not exist'
          USING ERRCODE = '23503';
      END IF;

      IF NOT omni_memory_deletion_ids_are_canonical(NEW.descendant_memory_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.retrieval_trace_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.graph_node_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.graph_edge_ids)
        OR NEW.memory_id COLLATE "C" = ANY(NEW.descendant_memory_ids)
      THEN
        RAISE EXCEPTION 'Memory deletion receipt manifest ids are not canonical'
          USING ERRCODE = '23514';
      END IF;

      WITH RECURSIVE lineage AS (
        SELECT NEW.memory_id COLLATE "C" AS current_memory_id
        UNION
        SELECT child.id
        FROM lineage
        JOIN omni_memories child
          ON child.tenant_id = NEW.tenant_id
         AND (
           child.supersedes_id = lineage.current_memory_id
           OR child.contradiction_of_id = lineage.current_memory_id
           OR ('memory:' || lineage.current_memory_id) = ANY(child.evidence_refs)
         )
      )
      SELECT ARRAY_AGG(
               current_memory_id COLLATE "C"
               ORDER BY current_memory_id COLLATE "C"
             )
               FILTER (WHERE current_memory_id <> NEW.memory_id),
             ARRAY_AGG(
               current_memory_id COLLATE "C"
               ORDER BY current_memory_id COLLATE "C"
             )
      INTO expected_descendant_memory_ids, blocked_memory_ids
      FROM lineage;

      expected_descendant_memory_ids := COALESCE(
        expected_descendant_memory_ids,
        '{}'::TEXT[]
      );
      blocked_memory_ids := COALESCE(
        blocked_memory_ids,
        ARRAY[NEW.memory_id]
      );

      IF NEW.descendant_memory_ids IS DISTINCT FROM
           expected_descendant_memory_ids
      THEN
        RAISE EXCEPTION 'Memory deletion receipt descendant closure is stale'
          USING ERRCODE = '40001';
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(trace.id COLLATE "C" ORDER BY trace.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_retrieval_trace_ids
      FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND (
          trace.memory_ids && blocked_memory_ids
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(trace.results) = 'array'
                  THEN trace.results
                ELSE '[]'::JSONB
              END
            ) result
            WHERE result ->> 'kind' = 'memory'
              AND result ->> 'id' = ANY(blocked_memory_ids)
          )
        );

      SELECT COALESCE(
        ARRAY_AGG(node.id COLLATE "C" ORDER BY node.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_graph_node_ids
      FROM omni_memory_graph_nodes node
      WHERE node.tenant_id = NEW.tenant_id
        AND (
          node.memory_ids && blocked_memory_ids
          OR node.trace_ids && expected_retrieval_trace_ids
        );

      SELECT COALESCE(
        ARRAY_AGG(edge.id COLLATE "C" ORDER BY edge.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_graph_edge_ids
      FROM omni_memory_graph_edges edge
      WHERE edge.tenant_id = NEW.tenant_id
        AND (
          edge.memory_ids && blocked_memory_ids
          OR edge.trace_ids && expected_retrieval_trace_ids
          OR edge.source_node_id = ANY(expected_graph_node_ids)
          OR edge.target_node_id = ANY(expected_graph_node_ids)
        );

      IF NEW.retrieval_trace_ids IS DISTINCT FROM expected_retrieval_trace_ids
        OR NEW.graph_node_ids IS DISTINCT FROM expected_graph_node_ids
        OR NEW.graph_edge_ids IS DISTINCT FROM expected_graph_edge_ids
      THEN
        RAISE EXCEPTION 'Memory deletion receipt derived lineage is stale'
          USING ERRCODE = '40001';
      END IF;

      -- Delete the exact validated manifest before NEW becomes visible. Once
      -- the receipt exists, restrictive SELECT policies intentionally hide
      -- these rows and an invoker-side DELETE could otherwise affect zero.
      DELETE FROM omni_memory_graph_edges edge
      WHERE edge.tenant_id = NEW.tenant_id
        AND edge.id = ANY(NEW.graph_edge_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.graph_edge_count THEN
        RAISE EXCEPTION 'Memory deletion graph-edge manifest changed'
          USING ERRCODE = '40001';
      END IF;

      DELETE FROM omni_memory_graph_nodes node
      WHERE node.tenant_id = NEW.tenant_id
        AND node.id = ANY(NEW.graph_node_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.graph_node_count THEN
        RAISE EXCEPTION 'Memory deletion graph-node manifest changed'
          USING ERRCODE = '40001';
      END IF;

      DELETE FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND trace.id = ANY(NEW.retrieval_trace_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.retrieval_trace_count THEN
        RAISE EXCEPTION 'Memory deletion trace manifest changed'
          USING ERRCODE = '40001';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_enforce_memory_deletion_barrier()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      referenced_memory_ids TEXT[];
      locked_memory_id TEXT;
      canonical_forget BOOLEAN := FALSE;
    BEGIN
      -- Every memory mutation participates in the tenant graph lock before
      -- taking narrower memory locks. This serializes new transitive lineage
      -- with receipt closure snapshots and keeps lock order deterministic.
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF TG_OP = 'UPDATE'
        AND (
          NEW.id IS DISTINCT FROM OLD.id
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        )
      THEN
        RAISE EXCEPTION 'Memory tenant and id are immutable'
          USING ERRCODE = '23514';
      END IF;

      referenced_memory_ids := ARRAY[
        NEW.id,
        NEW.supersedes_id,
        NEW.contradiction_of_id
      ] || ARRAY(
        SELECT substring(evidence_ref FROM 8)
        FROM unnest(COALESCE(NEW.evidence_refs, '{}'::TEXT[])) evidence_ref
        WHERE evidence_ref LIKE 'memory:%'
          AND char_length(evidence_ref) > 7
      );
      referenced_memory_ids := array_remove(referenced_memory_ids, NULL);

      FOR locked_memory_id IN
        SELECT DISTINCT memory_id COLLATE "C" AS memory_id
        FROM unnest(referenced_memory_ids) memory_id
        ORDER BY memory_id COLLATE "C"
      LOOP
        PERFORM pg_advisory_xact_lock(
          hashtext(NEW.tenant_id),
          hashtext('memory:' || locked_memory_id)
        );
      END LOOP;

      IF TG_OP = 'UPDATE'
        AND OLD.claim_status <> 'forgotten'
        AND NEW.claim_status = 'forgotten'
        AND NEW.title = '[forgotten]'
        AND NEW.content = ''
        AND cardinality(NEW.tags) = 0
        AND NEW.source = '[forgotten]'
        AND NEW.embedding IS NULL
        AND cardinality(NEW.evidence_refs) = 0
        AND NEW.supersedes_id IS NULL
        AND NEW.contradiction_of_id IS NULL
        AND NEW.forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(NEW) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB
        AND EXISTS (
          SELECT 1
          FROM omni_memory_deletion_receipts receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.memory_id = NEW.id
            AND receipt.forgotten_at = NEW.forgotten_at
        )
      THEN
        canonical_forget := TRUE;
      END IF;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        referenced_memory_ids
      ) AND NOT canonical_forget THEN
        RAISE EXCEPTION 'Memory write intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_canonical_memory_forget()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      final_memory omni_memories%ROWTYPE;
      final_referenced_memory_ids TEXT[];
      canonical_shell BOOLEAN := FALSE;
      canonical_forget BOOLEAN := FALSE;
    BEGIN
      -- Prefer the final stored row when it remains selectable. A row that a
      -- concurrently committed barrier now hides from RLS must still be
      -- rejected, so retain the queued NEW image as the fail-closed fallback.
      final_memory := NEW;
      SELECT stored_memory.*
      INTO final_memory
      FROM omni_memories stored_memory
      WHERE stored_memory.tenant_id = NEW.tenant_id
        AND stored_memory.id = NEW.id;

      IF NOT FOUND THEN
        final_memory := NEW;
      END IF;

      final_referenced_memory_ids := ARRAY[
        final_memory.id,
        final_memory.supersedes_id,
        final_memory.contradiction_of_id
      ] || ARRAY(
        SELECT substring(evidence_ref FROM 8)
        FROM unnest(
          COALESCE(final_memory.evidence_refs, '{}'::TEXT[])
        ) evidence_ref
        WHERE evidence_ref LIKE 'memory:%'
          AND char_length(evidence_ref) > 7
      );
      final_referenced_memory_ids := array_remove(
        final_referenced_memory_ids,
        NULL
      );

      IF EXISTS (
        SELECT 1
        FROM unnest(final_referenced_memory_ids) reference(memory_id)
        WHERE reference.memory_id <> final_memory.id
          AND NOT EXISTS (
            SELECT 1
            FROM omni_memories target
            WHERE target.tenant_id = final_memory.tenant_id
              AND target.id = reference.memory_id
          )
      ) THEN
        RAISE EXCEPTION
          'Memory lineage references an unknown or cross-tenant memory'
          USING ERRCODE = '23503';
      END IF;

      canonical_shell := COALESCE(
        final_memory.claim_status = 'forgotten'
        AND final_memory.title = '[forgotten]'
        AND final_memory.content = ''
        AND cardinality(final_memory.tags) = 0
        AND final_memory.source = '[forgotten]'
        AND final_memory.embedding IS NULL
        AND cardinality(final_memory.evidence_refs) = 0
        AND final_memory.supersedes_id IS NULL
        AND final_memory.contradiction_of_id IS NULL
        AND final_memory.forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(final_memory) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB,
        FALSE
      );
      canonical_forget := canonical_shell AND EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = final_memory.tenant_id
          AND receipt.memory_id = final_memory.id
          AND receipt.forgotten_at = final_memory.forgotten_at
      );

      IF omni_memory_ids_have_deletion_barrier(
        final_memory.tenant_id,
        final_referenced_memory_ids
      ) AND NOT canonical_forget THEN
        RAISE EXCEPTION
          'Final memory state intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      IF final_memory.claim_status <> 'forgotten' THEN
        RETURN NEW;
      END IF;

      IF NOT canonical_shell THEN
        RAISE EXCEPTION 'Forgotten memory is not canonically scrubbed'
          USING ERRCODE = '23514';
      END IF;

      IF NOT canonical_forget THEN
        RAISE EXCEPTION 'Forgotten memory is missing its deletion receipt'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_derived_memory_barrier()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      -- The BEFORE lineage trigger can wait behind a concurrent forget after
      -- its statement snapshot was chosen. Re-check from this deferred trigger
      -- so the transaction observes the committed receipt before it can finish.
      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        COALESCE(NEW.memory_ids, '{}'::TEXT[])
      ) THEN
        RAISE EXCEPTION
          'Final derived memory row intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_deletion_receipt_end_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_memories memory
        WHERE memory.tenant_id = NEW.tenant_id
          AND memory.id = NEW.memory_id
          AND memory.claim_status = 'forgotten'
          AND memory.title = '[forgotten]'
          AND memory.content = ''
          AND cardinality(memory.tags) = 0
          AND memory.source = '[forgotten]'
          AND memory.embedding IS NULL
          AND cardinality(memory.evidence_refs) = 0
          AND memory.supersedes_id IS NULL
          AND memory.contradiction_of_id IS NULL
          AND memory.forgotten_at = NEW.forgotten_at
          AND COALESCE(
            to_jsonb(memory) -> 'embedding_vector',
            'null'::JSONB
          ) = 'null'::JSONB
      ) THEN
        RAISE EXCEPTION 'Memory deletion receipt did not commit a canonical forget'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = NEW.tenant_id
          AND trace.id = ANY(NEW.retrieval_trace_ids)
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes node
        WHERE node.tenant_id = NEW.tenant_id
          AND node.id = ANY(NEW.graph_node_ids)
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        WHERE edge.tenant_id = NEW.tenant_id
          AND edge.id = ANY(NEW.graph_edge_ids)
      ) THEN
        RAISE EXCEPTION
          'Memory deletion receipt retained rows from its derived manifest'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql.query(`
    REVOKE ALL ON FUNCTION
      omni_validate_memory_deletion_receipt_end_state()
    FROM PUBLIC
  `);

  await sql`
    CREATE OR REPLACE FUNCTION omni_materialize_trace_memory_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      graph_reference_count INTEGER;
      resolved_graph_count INTEGER;
      direct_memory_ids TEXT[];
      materialized_memory_ids TEXT[];
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF jsonb_typeof(NEW.results) <> 'array'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(NEW.results) = 'array'
                THEN NEW.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE jsonb_typeof(result) <> 'object'
            OR COALESCE(result ->> 'kind', '') NOT IN (
              'memory', 'knowledge', 'graph'
            )
            OR NULLIF(BTRIM(result ->> 'id'), '') IS NULL
        )
      THEN
        RAISE EXCEPTION 'Retrieval trace results have invalid lineage'
          USING ERRCODE = '23514';
      END IF;

      direct_memory_ids := omni_direct_trace_memory_ids(NEW.results);
      IF EXISTS (
        SELECT 1
        FROM unnest(direct_memory_ids) memory_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM omni_memories memory
          WHERE memory.id = memory_id
            AND memory.tenant_id = NEW.tenant_id
        )
      ) THEN
        RAISE EXCEPTION 'Retrieval trace references an unknown tenant memory'
          USING ERRCODE = '23503';
      END IF;

      SELECT COUNT(DISTINCT (result ->> 'id') COLLATE "C")
      INTO graph_reference_count
      FROM jsonb_array_elements(NEW.results) result
      WHERE result ->> 'kind' = 'graph';

      SELECT COUNT(DISTINCT node.id COLLATE "C")
      INTO resolved_graph_count
      FROM jsonb_array_elements(NEW.results) result
      JOIN omni_memory_graph_nodes node
        ON node.id = result ->> 'id'
       AND node.tenant_id = NEW.tenant_id
      WHERE result ->> 'kind' = 'graph';

      IF graph_reference_count <> resolved_graph_count THEN
        RAISE EXCEPTION 'Retrieval trace references an unknown tenant graph node'
          USING ERRCODE = '23503';
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT lineage.memory_id COLLATE "C"
          ORDER BY lineage.memory_id COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      INTO materialized_memory_ids
      FROM (
        SELECT unnest(direct_memory_ids) AS memory_id
        UNION ALL
        SELECT unnest(node.memory_ids) AS memory_id
        FROM jsonb_array_elements(NEW.results) result
        JOIN omni_memory_graph_nodes node
          ON node.id = result ->> 'id'
         AND node.tenant_id = NEW.tenant_id
        WHERE result ->> 'kind' = 'graph'
      ) lineage;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        materialized_memory_ids
      ) THEN
        RAISE EXCEPTION 'Retrieval trace intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      NEW.memory_ids := materialized_memory_ids;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_materialize_graph_memory_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      trace_reference_count INTEGER;
      resolved_trace_count INTEGER;
      endpoint_reference_count INTEGER;
      resolved_endpoint_count INTEGER;
      materialized_memory_ids TEXT[];
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF EXISTS (
        SELECT 1
        FROM unnest(COALESCE(NEW.memory_ids, '{}'::TEXT[])) memory_id
        WHERE NULLIF(BTRIM(memory_id), '') IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM omni_memories memory
            WHERE memory.id = memory_id
              AND memory.tenant_id = NEW.tenant_id
          )
      ) THEN
        RAISE EXCEPTION 'Memory graph row references an unknown tenant memory'
          USING ERRCODE = '23503';
      END IF;

      SELECT COUNT(DISTINCT trace_id COLLATE "C")
      INTO trace_reference_count
      FROM unnest(COALESCE(NEW.trace_ids, '{}'::TEXT[])) trace_id;

      SELECT COUNT(DISTINCT trace.id COLLATE "C")
      INTO resolved_trace_count
      FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND trace.id = ANY(COALESCE(NEW.trace_ids, '{}'::TEXT[]));

      IF trace_reference_count <> resolved_trace_count THEN
        RAISE EXCEPTION 'Memory graph row references an unknown tenant trace'
          USING ERRCODE = '23503';
      END IF;

      IF TG_TABLE_NAME = 'omni_memory_graph_edges' THEN
        SELECT COUNT(DISTINCT endpoint_id COLLATE "C")
        INTO endpoint_reference_count
        FROM unnest(
          ARRAY[NEW.source_node_id, NEW.target_node_id]
        ) endpoint_id;

        SELECT COUNT(DISTINCT endpoint.id COLLATE "C")
        INTO resolved_endpoint_count
        FROM omni_memory_graph_nodes endpoint
        WHERE endpoint.tenant_id = NEW.tenant_id
          AND endpoint.id = ANY(
            ARRAY[NEW.source_node_id, NEW.target_node_id]
          );

        IF endpoint_reference_count <> resolved_endpoint_count THEN
          RAISE EXCEPTION
            'Memory graph edge references an unknown or cross-tenant endpoint'
            USING ERRCODE = '23503';
        END IF;
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT lineage.memory_id COLLATE "C"
          ORDER BY lineage.memory_id COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      INTO materialized_memory_ids
      FROM (
        SELECT unnest(COALESCE(NEW.memory_ids, '{}'::TEXT[])) AS memory_id
        UNION ALL
        SELECT unnest(trace.memory_ids) AS memory_id
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = NEW.tenant_id
          AND trace.id = ANY(COALESCE(NEW.trace_ids, '{}'::TEXT[]))
      ) lineage;

      IF TG_TABLE_NAME = 'omni_memory_graph_edges' THEN
        SELECT COALESCE(
          ARRAY_AGG(
            DISTINCT lineage.memory_id COLLATE "C"
            ORDER BY lineage.memory_id COLLATE "C"
          ),
          '{}'::TEXT[]
        )
        INTO materialized_memory_ids
        FROM (
          SELECT unnest(materialized_memory_ids) AS memory_id
          UNION ALL
          SELECT unnest(endpoint.memory_ids) AS memory_id
          FROM omni_memory_graph_nodes endpoint
          WHERE endpoint.tenant_id = NEW.tenant_id
            AND endpoint.id = ANY(
              ARRAY[NEW.source_node_id, NEW.target_node_id]
            )
        ) lineage;
      END IF;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        materialized_memory_ids
      ) THEN
        RAISE EXCEPTION 'Memory graph row intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      NEW.memory_ids := materialized_memory_ids;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_validate'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_validate
        BEFORE INSERT ON omni_memory_deletion_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_immutable'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_immutable
        BEFORE UPDATE OR DELETE ON omni_memory_deletion_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_no_truncate'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_no_truncate
        BEFORE TRUNCATE ON omni_memory_deletion_receipts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_validate_end_state'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_deletion_receipts_validate_end_state
        AFTER INSERT ON omni_memory_deletion_receipts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_memory_deletion_receipt_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_graph_lock'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memories
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_deletion_barrier'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_deletion_barrier
        BEFORE INSERT OR UPDATE ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_enforce_memory_deletion_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_no_delete'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_no_delete
        BEFORE DELETE ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_memory_delete();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_no_truncate'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_no_truncate
        BEFORE TRUNCATE ON omni_memories
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_memory_delete();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_validate_canonical_forget'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_memories_validate_canonical_forget
        AFTER INSERT OR UPDATE ON omni_memories
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_canonical_memory_forget();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_memory_lineage'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_retrieval_traces_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, results, memory_ids
        ON omni_retrieval_traces
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_trace_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_graph_lock'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_retrieval_traces_graph_lock
        BEFORE INSERT OR UPDATE ON omni_retrieval_traces
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_validate_deletion_barrier'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_retrieval_traces_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_retrieval_traces
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_memory_lineage'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_nodes_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, memory_ids, trace_ids
        ON omni_memory_graph_nodes
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_graph_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_graph_lock'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_nodes_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memory_graph_nodes
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_validate_deletion_barrier'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_graph_nodes_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_memory_graph_nodes
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_memory_lineage'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_edges_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, source_node_id, target_node_id,
          memory_ids, trace_ids
        ON omni_memory_graph_edges
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_graph_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_graph_lock'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_edges_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memory_graph_edges
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_validate_deletion_barrier'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_graph_edges_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_memory_graph_edges
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_deletion_receipts_actor_created_idx
    ON omni_memory_deletion_receipts (
      tenant_id, initiating_actor_id, created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_deletion_receipts_descendants_idx
    ON omni_memory_deletion_receipts USING GIN (descendant_memory_ids)
  `;

  await sql`
    ALTER TABLE omni_memory_deletion_receipts ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_deletion_receipts FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_nodes ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_nodes FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_edges ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_edges FORCE ROW LEVEL SECURITY
  `;

  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memories
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memories
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, ARRAY[id])
      OR EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts pending_receipt
        WHERE pending_receipt.tenant_id = omni_memories.tenant_id
          AND pending_receipt.memory_id = omni_memories.id
      )
      OR (
        claim_status = 'forgotten'
        AND title = '[forgotten]'
        AND content = ''
        AND cardinality(tags) = 0
        AND source = '[forgotten]'
        AND embedding IS NULL
        AND cardinality(evidence_refs) = 0
        AND supersedes_id IS NULL
        AND contradiction_of_id IS NULL
        AND forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(omni_memories) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB
      )
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_retrieval_traces
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memory_graph_edges
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
      AND EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes source_endpoint
        WHERE source_endpoint.tenant_id = omni_memory_graph_edges.tenant_id
          AND source_endpoint.id = omni_memory_graph_edges.source_node_id
      )
      AND EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes target_endpoint
        WHERE target_endpoint.tenant_id = omni_memory_graph_edges.tenant_id
          AND target_endpoint.id = omni_memory_graph_edges.target_node_id
      )
    )
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_memory_deletion_receipts FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND privilege_type IN ('SELECT', 'INSERT')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_memory_deletion_receipts TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      -- A serving role capable of the full memory mutation boundary must also
      -- be able to invalidate tenant-scoped derived rows in the same forget
      -- transaction. Read-only and partial roles receive no new capability.
      FOR grant_record IN
        SELECT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
        GROUP BY grantee
        HAVING COUNT(DISTINCT privilege_type) = 3
      LOOP
        EXECUTE format(
          'GRANT DELETE ON TABLE %I.omni_retrieval_traces, ' ||
          '%I.omni_memory_graph_edges, %I.omni_memory_graph_nodes TO %I',
          current_schema(),
          current_schema(),
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

export async function ensureMemoryDeletionScrubLeaseContract(sql: SqlClient) {
  // The receipt ledger remains unreadable to ordinary runtime and maintenance
  // roles. This owner function exposes only bounded manifests to an explicit
  // system-scoped schema owner or dedicated BYPASSRLS maintenance session.
  // Receipt row locks live until the caller's surrounding transaction ends.
  await sql`
    CREATE OR REPLACE FUNCTION omni_lease_memory_deletion_scrub_receipts(
      candidate_limit INTEGER
    )
    RETURNS TABLE (
      id TEXT,
      tenant_id TEXT,
      memory_id TEXT,
      descendant_memory_ids TEXT[],
      descendant_memory_count INTEGER,
      attribution_kind TEXT,
      execution_scope JSONB,
      forgotten_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF COALESCE(current_setting('omni.system_scope', TRUE), '') <> 'true'
        OR NULLIF(current_setting('omni.system_reason', TRUE), '') IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles session_role
          WHERE session_role.rolname = session_user
            AND (
              session_role.rolbypassrls
              OR session_role.oid = (
                SELECT relation.relowner
                FROM pg_catalog.pg_class relation
                WHERE relation.oid = 'public.omni_schema_version'::regclass
              )
            )
            AND (
              NOT session_role.rolsuper
              OR session_role.oid = (
                SELECT relation.relowner
                FROM pg_catalog.pg_class relation
                WHERE relation.oid = 'public.omni_schema_version'::regclass
              )
            )
        )
      THEN
        RAISE EXCEPTION 'Memory deletion scrub leasing requires an audited maintenance scope'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT
        receipt.id,
        receipt.tenant_id,
        receipt.memory_id,
        receipt.descendant_memory_ids,
        receipt.descendant_memory_count,
        receipt.attribution_kind,
        receipt.execution_scope,
        receipt.forgotten_at,
        receipt.created_at
      FROM public.omni_memory_deletion_receipts receipt
      WHERE cardinality(receipt.descendant_memory_ids) > 0
        AND EXISTS (
          SELECT 1
          FROM public.omni_memories memory
          WHERE memory.tenant_id = receipt.tenant_id
            AND memory.id = ANY(receipt.descendant_memory_ids)
            AND (
              memory.title IS DISTINCT FROM '[forgotten]'
              OR memory.content IS DISTINCT FROM ''
              OR memory.tags IS DISTINCT FROM '{}'::TEXT[]
              OR memory.source IS DISTINCT FROM '[forgotten]'
              OR memory.embedding IS NOT NULL
              OR COALESCE(
                pg_catalog.to_jsonb(memory) -> 'embedding_vector',
                'null'::JSONB
              ) <> 'null'::JSONB
              OR memory.evidence_refs IS DISTINCT FROM '{}'::TEXT[]
              OR memory.supersedes_id IS NOT NULL
              OR memory.contradiction_of_id IS NOT NULL
              OR memory.claim_status IS DISTINCT FROM 'forgotten'
              OR memory.forgotten_at IS NULL
            )
        )
      ORDER BY receipt.created_at ASC, receipt.tenant_id ASC, receipt.id ASC
      FOR UPDATE OF receipt SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(candidate_limit, 1), 1), 50);
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_lease_memory_deletion_scrub_receipts(INTEGER)
    FROM PUBLIC
  `;
  await sql`
    GRANT EXECUTE ON FUNCTION omni_lease_memory_deletion_scrub_receipts(INTEGER)
    TO PUBLIC
  `;
}

export async function ensureMemoryAccessScopeShadow(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_contract_version SMALLINT NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'legacy_unattributed'
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS owner_actor_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS owner_agent_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS workspace_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS project_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS mission_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS visibility TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS sensitivity TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS origin_purpose TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS allowed_purpose_ids TEXT[]
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_scope_sha256 TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_bound_at TIMESTAMPTZ
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_contract_check'
          AND conrelid = 'omni_memories'::regclass
      ) THEN
        ALTER TABLE omni_memories
        ADD CONSTRAINT omni_memories_access_contract_check CHECK (
          (
            access_contract_version = 0
            AND access_state = 'legacy_unattributed'
            AND owner_actor_id IS NULL
            AND owner_agent_id IS NULL
            AND workspace_id IS NULL
            AND project_id IS NULL
            AND mission_id IS NULL
            AND visibility IS NULL
            AND sensitivity IS NULL
            AND origin_purpose IS NULL
            AND allowed_purpose_ids IS NULL
            AND access_scope_sha256 IS NULL
            AND access_bound_at IS NULL
          )
          OR (
            access_contract_version = 1
            AND access_state = 'scope_bound'
            AND omni_source_contract_id_is_valid(owner_actor_id)
            AND visibility IS NOT NULL
            AND visibility IN (
              'agent_private', 'user_private', 'mission_shared',
              'project_shared', 'workspace_shared'
            )
            AND sensitivity IS NOT NULL
            AND sensitivity IN (
              'public', 'internal', 'confidential', 'restricted'
            )
            AND NULLIF(BTRIM(origin_purpose), '') IS NOT NULL
            AND char_length(origin_purpose) <= 500
            AND allowed_purpose_ids IS NOT NULL
            AND array_ndims(allowed_purpose_ids) = 1
            AND array_lower(allowed_purpose_ids, 1) = 1
            AND cardinality(allowed_purpose_ids) BETWEEN 1 AND 32
            AND omni_source_id_array_is_canonical(allowed_purpose_ids, 32)
            AND access_scope_sha256 IS NOT NULL
            AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
            AND access_bound_at IS NOT NULL
            AND (
              visibility <> 'agent_private'
              OR omni_source_contract_id_is_valid(owner_agent_id)
            )
            AND (
              visibility <> 'mission_shared'
              OR omni_source_contract_id_is_valid(mission_id)
            )
            AND (
              visibility <> 'project_shared'
              OR omni_source_contract_id_is_valid(project_id)
            )
            AND (
              visibility <> 'workspace_shared'
              OR omni_source_contract_id_is_valid(workspace_id)
            )
            AND (
              owner_agent_id IS NULL
              OR omni_source_contract_id_is_valid(owner_agent_id)
            )
            AND (
              workspace_id IS NULL
              OR omni_source_contract_id_is_valid(workspace_id)
            )
            AND (
              project_id IS NULL
              OR omni_source_contract_id_is_valid(project_id)
            )
            AND (
              mission_id IS NULL
              OR omni_source_contract_id_is_valid(mission_id)
            )
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_access_contract_check
  `;

  // RLS does not constrain the maintenance connection. Keep the access
  // contract completely dormant until the later atomic runtime cutover drops
  // this enrollment lock in the same migration that activates every reader.
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
      ) THEN
        ALTER TABLE omni_memories
        ADD CONSTRAINT omni_memories_access_enrollment_hold_check CHECK (
          access_contract_version = 0
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_access_enrollment_hold_check
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_bound_memory_access_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.access_contract_version = 1
        AND ROW(
          OLD.tenant_id,
          OLD.access_contract_version,
          OLD.access_state,
          OLD.owner_actor_id,
          OLD.owner_agent_id,
          OLD.workspace_id,
          OLD.project_id,
          OLD.mission_id,
          OLD.visibility,
          OLD.sensitivity,
          OLD.origin_purpose,
          OLD.allowed_purpose_ids,
          OLD.access_scope_sha256,
          OLD.access_bound_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id,
          NEW.access_contract_version,
          NEW.access_state,
          NEW.owner_actor_id,
          NEW.owner_agent_id,
          NEW.workspace_id,
          NEW.project_id,
          NEW.mission_id,
          NEW.visibility,
          NEW.sensitivity,
          NEW.origin_purpose,
          NEW.allowed_purpose_ids,
          NEW.access_scope_sha256,
          NEW.access_bound_at
        )
      THEN
        RAISE EXCEPTION 'Bound memory access scope is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_memories_access_scope_immutable'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_access_scope_immutable
        BEFORE UPDATE OF
          tenant_id, access_contract_version, access_state, owner_actor_id,
          owner_agent_id, workspace_id, project_id, mission_id,
          visibility, sensitivity, origin_purpose, allowed_purpose_ids,
          access_scope_sha256, access_bound_at
        ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_bound_memory_access_change();
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_access_scope_idx
    ON omni_memories (
      tenant_id, visibility, owner_actor_id, owner_agent_id,
      workspace_id, project_id, mission_id, updated_at DESC
    )
    WHERE access_contract_version = 1
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_allowed_purposes_idx
    ON omni_memories USING GIN (allowed_purpose_ids)
    WHERE access_contract_version = 1
  `;

  // A v1 access envelope is deliberately inert until every memory, RAG,
  // graph, export, and worker path enters the same actor-aware database scope.
  // Rollback binaries continue to create version-0 compatibility rows.
  await sql`
    DROP POLICY IF EXISTS omni_memory_access_scope_holdback
    ON omni_memories
  `;
  await sql`
    CREATE POLICY omni_memory_access_scope_holdback
    ON omni_memories
    AS RESTRICTIVE
    FOR ALL
    USING (
      access_contract_version = 0
      OR omni_system_scope_enabled()
    )
    WITH CHECK (
      access_contract_version = 0
      OR omni_system_scope_enabled()
    )
  `;

  // Default privileges on a newly created table may grant more than the
  // receipt runtime needs. Triggers already reject mutation; remove the
  // unnecessary capabilities as a second independent control.
  await sql.query(`
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON TABLE omni_memory_deletion_receipts
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_deletion_receipts'
          AND privilege_type IN (
            'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
          )
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ' ||
          'ON TABLE %I.omni_memory_deletion_receipts FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      -- Table-level revocation does not remove privileges granted directly on
      -- individual columns. Remove those independent mutation paths too.
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_deletion_receipts'
          AND privilege_type IN ('UPDATE', 'REFERENCES')
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %I.omni_memory_deletion_receipts FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;
    END
    $migration$
  `);
}

export async function ensureMemoryAccessSessionContractShadow(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_grant_ids_v1_are_canonical(
      value_to_check JSONB,
      maximum_entries INTEGER
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(value_to_check) IS DISTINCT FROM 'array' THEN FALSE
        WHEN maximum_entries NOT BETWEEN 0 AND 256 THEN FALSE
        WHEN jsonb_array_length(value_to_check) > maximum_entries THEN FALSE
        ELSE NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              entry.value,
              CASE
                WHEN jsonb_typeof(entry.value) = 'string'
                  THEN entry.value #>> '{}'
                ELSE NULL
              END AS id,
              lag(
                CASE
                  WHEN jsonb_typeof(entry.value) = 'string'
                    THEN entry.value #>> '{}'
                  ELSE NULL
                END
              ) OVER (ORDER BY entry.ordinal_position) AS previous_id
            FROM jsonb_array_elements(value_to_check)
              WITH ORDINALITY AS entry(value, ordinal_position)
          ) ordered_ids
          WHERE jsonb_typeof(ordered_ids.value) IS DISTINCT FROM 'string'
            OR NOT public.omni_source_contract_id_is_valid(ordered_ids.id)
            OR (
              ordered_ids.previous_id IS NOT NULL
              AND ordered_ids.id COLLATE "C"
                <= ordered_ids.previous_id COLLATE "C"
            )
        )
      END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_scope_v1_is_valid(
      candidate JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(candidate) IS DISTINCT FROM 'object' THEN FALSE
        ELSE COALESCE((
          candidate ?& ARRAY[
            'version', 'tenantId', 'initiatingActorId',
            'executingPrincipalType', 'executingPrincipalId',
            'workspaceId', 'projectId', 'missionId',
            'contextGrantIds', 'capabilityGrantIds',
            'purposeId', 'purpose'
          ]
          AND candidate - ARRAY[
            'version', 'tenantId', 'initiatingActorId',
            'executingPrincipalType', 'executingPrincipalId',
            'workspaceId', 'projectId', 'missionId',
            'contextGrantIds', 'capabilityGrantIds',
            'purposeId', 'purpose'
          ] = '{}'::JSONB
          AND public.omni_jsonb_safe_integer(candidate -> 'version', 1)
          AND public.omni_jsonb_safe_integer_value(
            candidate -> 'version'
          ) = 1
          AND jsonb_typeof(candidate -> 'tenantId') = 'string'
          AND public.omni_source_contract_id_is_valid(candidate ->> 'tenantId')
          AND jsonb_typeof(candidate -> 'initiatingActorId') = 'string'
          AND public.omni_source_contract_id_is_valid(
            candidate ->> 'initiatingActorId'
          )
          AND jsonb_typeof(candidate -> 'executingPrincipalType') = 'string'
          AND candidate ->> 'executingPrincipalType' IN (
            'user', 'agent', 'system'
          )
          AND jsonb_typeof(candidate -> 'executingPrincipalId') = 'string'
          AND public.omni_source_contract_id_is_valid(
            candidate ->> 'executingPrincipalId'
          )
          AND (
            candidate ->> 'executingPrincipalType' <> 'user'
            OR candidate ->> 'executingPrincipalId'
              = candidate ->> 'initiatingActorId'
          )
          AND CASE
            WHEN candidate -> 'workspaceId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'workspaceId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'workspaceId'
              )
            ELSE FALSE
          END
          AND CASE
            WHEN candidate -> 'projectId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'projectId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'projectId'
              )
            ELSE FALSE
          END
          AND CASE
            WHEN candidate -> 'missionId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'missionId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'missionId'
              )
            ELSE FALSE
          END
          AND public.omni_memory_access_grant_ids_v1_are_canonical(
            candidate -> 'contextGrantIds',
            256
          )
          AND public.omni_memory_access_grant_ids_v1_are_canonical(
            candidate -> 'capabilityGrantIds',
            256
          )
          AND jsonb_typeof(candidate -> 'purposeId') = 'string'
          AND public.omni_source_contract_id_is_valid(candidate ->> 'purposeId')
          AND CASE
            WHEN candidate -> 'purpose' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'purpose') = 'string' THEN
              candidate ->> 'purpose' = btrim(candidate ->> 'purpose')
              AND char_length(candidate ->> 'purpose') BETWEEN 1 AND 500
            ELSE FALSE
          END
        ), FALSE)
      END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_current_memory_access_scope_v1()
    RETURNS JSONB
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      raw_scope TEXT;
      parsed_scope JSONB;
    BEGIN
      raw_scope := NULLIF(
        current_setting('omni.memory_access_scope_v1', TRUE),
        ''
      );
      IF raw_scope IS NULL OR octet_length(raw_scope) > 262144 THEN
        RETURN NULL;
      END IF;

      BEGIN
        parsed_scope := raw_scope::JSONB;
      EXCEPTION
        WHEN data_exception OR program_limit_exceeded THEN
          RETURN NULL;
      END;

      IF public.omni_memory_access_scope_v1_is_valid(parsed_scope)
        IS DISTINCT FROM TRUE
      THEN
        RETURN NULL;
      END IF;
      IF public.omni_current_tenant() IS NULL
        OR parsed_scope ->> 'tenantId'
          IS DISTINCT FROM public.omni_current_tenant()
      THEN
        RETURN NULL;
      END IF;
      IF current_setting('omni.system_scope', TRUE) IS DISTINCT FROM 'false' THEN
        RETURN NULL;
      END IF;

      RETURN parsed_scope;
    END
    $function$
  `;

  // Keep the shadow contract unavailable to serving roles until one later
  // cutover sets it transaction-locally and all memory-derived paths enforce it.
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_grant_ids_v1_are_canonical(JSONB, INTEGER)
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_scope_v1_is_valid(JSONB)
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_current_memory_access_scope_v1()
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_access_grant_ids_v1_are_canonical(JSONB, INTEGER), ' ||
          '%I.omni_memory_access_scope_v1_is_valid(JSONB), ' ||
          '%I.omni_current_memory_access_scope_v1() FROM %I',
          current_schema(),
          current_schema(),
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v44 is additive only. Abort if the v43 enrollment and RLS barriers have
  // drifted; this migration must not silently repair or relax either boundary.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:contract_check',
        'initiatingActorId', 'actor:contract_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:contract_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', jsonb_build_array('grant:a', 'grant:b'),
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:contract_check',
        'purpose', 'Memory access contract self-check'
      );

      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
      THEN
        RAISE EXCEPTION 'Memory access session contract rejected a valid scope'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Memory access session contract rejected an actor-bound system principal'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope - 'purposeId')
        IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Memory access session contract accepted a non-canonical scope'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment hold is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
      ) THEN
        RAISE EXCEPTION 'Memory access contract version default has drifted'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory access scope shadow contains an enrollment'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory access scope shadow requires forced RLS'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability trigger is missing or disabled'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access RLS holdback is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy depends on the dormant memory access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
          AND prorettype = 'boolean'::regtype
          AND provolatile = 'i'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
          AND prorettype = 'boolean'::regtype
          AND provolatile = 'i'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND prorettype = 'jsonb'::regtype
          AND provolatile = 's'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) THEN
        RAISE EXCEPTION 'Memory access session function metadata is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory access session functions have serving grants'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureMemoryAccessAuthorizationDenyHook(sql: SqlClient) {
  // Establish the eventual authorization boundary without fabricating
  // authority from OAuth grants, rollout state, or free-form purpose text.
  // The real resolver must replace this body and lock every authoritative
  // membership, principal, target, purpose, and grant row before activation.
  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_scope_v1_is_authorized(
      candidate JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    VOLATILE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT FALSE
    $function$
  `;

  // Serving roles cannot call the held hook until its authoritative inputs,
  // same-transaction locks, installer composition, and all-surface cutover
  // are complete.
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_scope_v1_is_authorized(JSONB)
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_access_scope_v1_is_authorized(JSONB) FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v45 is an additive, always-deny seam. Abort on any drift that would make
  // the hook reachable, enroll a v1 memory, or relax the v43 safety barriers.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:authorization_check',
        'initiatingActorId', 'actor:authorization_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:authorization_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:authorization_check',
        'purpose', 'Memory authorization deny-hook self-check'
      );

      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
      THEN
        RAISE EXCEPTION 'Memory authorization self-check scope is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_authorized(valid_scope)
        IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization hook did not deny'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public']
          AND language.lanname = 'sql'
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook metadata is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook has serving grants'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment hold is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook found an enrolled memory'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook requires forced RLS'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability trigger is missing or disabled'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access RLS holdback is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'A row policy depends on the dormant authorization hook'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
