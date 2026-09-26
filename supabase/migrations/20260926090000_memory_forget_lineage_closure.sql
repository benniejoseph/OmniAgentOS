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

  IF latest_version IS DISTINCT FROM 206 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 206
      AND name = 'prompt_queue_context_pins_v1'
      AND checksum = '5de8d38921e0d4d0f7e79bcfe4745f780ce973b009c874a519d09bfd8f3ff777'
  ) <> 1 THEN
    RAISE EXCEPTION 'Memory forget lineage predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Forget computes one lineage closure over every visibility.
-- Copies that the caller cannot read are still listed, scrubbed, and
-- receipted. Definers raise system scope inside their bodies and restore it
-- before returning, because a non-superuser owner cannot attach omni.*
-- settings to a function.

-- The owner of an agent may forget that agent's private memories. Only a
-- validated user forget scope whose initiating and executing actor is the
-- owner matches, so agents themselves still cannot forget.
CREATE OR REPLACE FUNCTION public.omni_agent_private_memory_owner_forget_v1_allows(
  row_tenant_id TEXT,
  row_owner_actor_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    public.omni_user_private_memory_scope_v1_allows_validated(
      public.omni_current_memory_access_scope_v1(),
      row_tenant_id,
      row_owner_actor_id,
      ARRAY['memory.forget.v1']::TEXT[]
    ),
    FALSE
  )
$function$;

-- A private memory may cite a private memory of the same owner that the
-- current scope cannot read, such as the source of an agent share. This
-- answers only inside the caller's own tenant and actor scope, and only
-- whether such a memory exists.
CREATE OR REPLACE FUNCTION public.omni_memory_reference_shares_owner_v1(
  row_tenant_id TEXT,
  row_owner_actor_id TEXT,
  referenced_memory_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_system_scope TEXT :=
    pg_catalog.current_setting('omni.system_scope', TRUE);
  previous_system_reason TEXT :=
    pg_catalog.current_setting('omni.system_reason', TRUE);
  reference_shares_owner BOOLEAN;
BEGIN
  IF row_tenant_id IS NULL
    OR row_owner_actor_id IS NULL
    OR referenced_memory_id IS NULL
    OR row_tenant_id IS DISTINCT FROM public.omni_current_tenant()
    OR NOT COALESCE(
      public.omni_actor_scope_v1_allows(row_tenant_id, row_owner_actor_id),
      FALSE
    )
  THEN
    RETURN FALSE;
  END IF;

  PERFORM pg_catalog.set_config('omni.system_scope', 'true', TRUE);
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    'memory lineage owner reference check',
    TRUE
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.omni_memories referenced
    WHERE referenced.tenant_id = row_tenant_id
      AND referenced.id = referenced_memory_id
      AND referenced.owner_actor_id = row_owner_actor_id
      AND referenced.access_contract_version = 1
      AND referenced.access_state = 'scope_bound'
      AND referenced.visibility IN ('user_private', 'agent_private')
  )
  INTO reference_shares_owner;

  PERFORM pg_catalog.set_config(
    'omni.system_scope',
    COALESCE(previous_system_scope, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    COALESCE(previous_system_reason, ''),
    TRUE
  );
  RETURN COALESCE(reference_shares_owner, FALSE);
END
$function$;

-- Lineage definers must see descendants that the deletion barrier hides:
-- those rows are what they list, scrub, and check. The flag counts only
-- together with owner system scope, which a serving role cannot hold.
ALTER POLICY omni_memory_deletion_barrier ON public.omni_memories
USING (
  (
    COALESCE(
      pg_catalog.current_setting('omni.memory_deletion_lineage', TRUE),
      ''
    ) = 'true'
    AND public.omni_system_scope_enabled()
  )
  OR NOT public.omni_memory_ids_have_deletion_barrier(tenant_id, ARRAY[id])
  OR public.omni_memory_has_deletion_receipt(tenant_id, id)
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
      pg_catalog.to_jsonb(omni_memories.*) -> 'embedding_vector',
      'null'::JSONB
    ) = 'null'::JSONB
  )
);

-- The owner's forget scope reaches their agents' private memories, and may
-- write them back only as forgotten shells.
ALTER POLICY omni_memory_access_scope_holdback ON public.omni_memories
USING (
  public.omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      owner_agent_id,
      allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND public.omni_shared_memory_scope_v1_allows(
      id,
      tenant_id,
      workspace_id,
      project_id,
      visibility,
      allowed_purpose_ids,
      octet_length(title)::BIGINT + octet_length(content)::BIGINT
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_owner_forget_v1_allows(
      tenant_id,
      owner_actor_id
    )
  )
)
WITH CHECK (
  public.omni_system_scope_enabled()
  OR (
    access_contract_version = 0
    AND public.omni_current_memory_access_scope_v1() IS NULL
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'user_private'
    AND public.omni_user_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND public.omni_agent_private_memory_scope_v1_allows(
      tenant_id,
      owner_actor_id,
      owner_agent_id,
      allowed_purpose_ids
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility IN ('project_shared', 'workspace_shared')
    AND public.omni_shared_memory_scope_v1_allows(
      id,
      tenant_id,
      workspace_id,
      project_id,
      visibility,
      allowed_purpose_ids,
      octet_length(title)::BIGINT + octet_length(content)::BIGINT
    )
  )
  OR (
    access_contract_version = 1
    AND access_state = 'scope_bound'
    AND visibility = 'agent_private'
    AND claim_status = 'forgotten'
    AND public.omni_agent_private_memory_owner_forget_v1_allows(
      tenant_id,
      owner_actor_id
    )
  )
);

-- The deletion manifest for one memory: its lineage closure over every
-- visibility and the derived rows that cite it. It returns ids only, and only
-- for the caller's tenant, so a serving role can build and check a receipt
-- for copies it cannot read.
CREATE OR REPLACE FUNCTION public.omni_memory_deletion_manifest_v1(
  row_tenant_id TEXT,
  row_memory_id TEXT
)
RETURNS TABLE (
  descendant_memory_ids TEXT[],
  retrieval_trace_ids TEXT[],
  graph_node_ids TEXT[],
  graph_edge_ids TEXT[]
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_system_scope TEXT :=
    pg_catalog.current_setting('omni.system_scope', TRUE);
  previous_system_reason TEXT :=
    pg_catalog.current_setting('omni.system_reason', TRUE);
  previous_deletion_lineage TEXT :=
    pg_catalog.current_setting('omni.memory_deletion_lineage', TRUE);
  manifest_descendant_memory_ids TEXT[];
  manifest_blocked_memory_ids TEXT[];
  manifest_retrieval_trace_ids TEXT[];
  manifest_graph_node_ids TEXT[];
  manifest_graph_edge_ids TEXT[];
BEGIN
  IF row_tenant_id IS NULL
    OR row_memory_id IS NULL
    OR row_tenant_id IS DISTINCT FROM public.omni_current_tenant()
  THEN
    RAISE EXCEPTION 'Memory deletion manifests are tenant-scoped'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('omni.system_scope', 'true', TRUE);
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    'memory deletion lineage manifest',
    TRUE
  );
  PERFORM pg_catalog.set_config('omni.memory_deletion_lineage', 'true', TRUE);

  WITH RECURSIVE lineage AS (
    SELECT row_memory_id COLLATE "C" AS current_memory_id
    UNION
    SELECT child.id
    FROM lineage
    JOIN public.omni_memories child
      ON child.tenant_id = row_tenant_id
     AND (
       child.supersedes_id = lineage.current_memory_id
       OR child.contradiction_of_id = lineage.current_memory_id
       OR ('memory:' || lineage.current_memory_id) = ANY(child.evidence_refs)
     )
  )
  SELECT ARRAY_AGG(
           lineage.current_memory_id COLLATE "C"
           ORDER BY lineage.current_memory_id COLLATE "C"
         ) FILTER (WHERE lineage.current_memory_id <> row_memory_id),
         ARRAY_AGG(
           lineage.current_memory_id COLLATE "C"
           ORDER BY lineage.current_memory_id COLLATE "C"
         )
  INTO manifest_descendant_memory_ids, manifest_blocked_memory_ids
  FROM lineage;

  manifest_descendant_memory_ids := COALESCE(
    manifest_descendant_memory_ids,
    '{}'::TEXT[]
  );
  manifest_blocked_memory_ids := COALESCE(
    manifest_blocked_memory_ids,
    ARRAY[row_memory_id]
  );

  SELECT COALESCE(
    ARRAY_AGG(trace.id COLLATE "C" ORDER BY trace.id COLLATE "C"),
    '{}'::TEXT[]
  )
  INTO manifest_retrieval_trace_ids
  FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = row_tenant_id
    AND (
      trace.memory_ids && manifest_blocked_memory_ids
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
          CASE
            WHEN pg_catalog.jsonb_typeof(trace.results) = 'array'
              THEN trace.results
            ELSE '[]'::JSONB
          END
        ) result
        WHERE result ->> 'kind' = 'memory'
          AND result ->> 'id' = ANY(manifest_blocked_memory_ids)
      )
    );

  SELECT COALESCE(
    ARRAY_AGG(node.id COLLATE "C" ORDER BY node.id COLLATE "C"),
    '{}'::TEXT[]
  )
  INTO manifest_graph_node_ids
  FROM public.omni_memory_graph_nodes node
  WHERE node.tenant_id = row_tenant_id
    AND (
      node.memory_ids && manifest_blocked_memory_ids
      OR node.trace_ids && manifest_retrieval_trace_ids
    );

  SELECT COALESCE(
    ARRAY_AGG(edge.id COLLATE "C" ORDER BY edge.id COLLATE "C"),
    '{}'::TEXT[]
  )
  INTO manifest_graph_edge_ids
  FROM public.omni_memory_graph_edges edge
  WHERE edge.tenant_id = row_tenant_id
    AND (
      edge.memory_ids && manifest_blocked_memory_ids
      OR edge.trace_ids && manifest_retrieval_trace_ids
      OR edge.source_node_id = ANY(manifest_graph_node_ids)
      OR edge.target_node_id = ANY(manifest_graph_node_ids)
    );

  PERFORM pg_catalog.set_config(
    'omni.system_scope',
    COALESCE(previous_system_scope, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    COALESCE(previous_system_reason, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.memory_deletion_lineage',
    COALESCE(previous_deletion_lineage, ''),
    TRUE
  );

  descendant_memory_ids := manifest_descendant_memory_ids;
  retrieval_trace_ids := manifest_retrieval_trace_ids;
  graph_node_ids := manifest_graph_node_ids;
  graph_edge_ids := manifest_graph_edge_ids;
  RETURN NEXT;
  RETURN;
END
$function$;

REVOKE ALL ON FUNCTION public.omni_memory_deletion_manifest_v1(TEXT, TEXT)
FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_memory_deletion_manifest_v1(TEXT, TEXT)
      TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT EXECUTE ON FUNCTION
      public.omni_memory_deletion_manifest_v1(TEXT, TEXT)
      TO omni_maintenance;
  END IF;
END
$roles$;

-- The receipt checks its manifest against the closure the database computes.
-- Deleting, scrubbing, and revoking happen in the apply trigger below, which
-- can reach the rows that this invoker cannot.
CREATE OR REPLACE FUNCTION public.omni_validate_memory_deletion_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  memory public.omni_memories%ROWTYPE;
  manifest RECORD;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('memory-graph:' || NEW.tenant_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(NEW.tenant_id),
    pg_catalog.hashtext('memory:' || NEW.memory_id)
  );

  IF EXISTS (
    SELECT 1
    FROM public.omni_memory_deletion_receipts receipt
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
  FROM public.omni_memories stored_memory
  WHERE stored_memory.tenant_id = NEW.tenant_id
    AND stored_memory.id = NEW.memory_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory deletion receipt target does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.omni_memory_deletion_ids_are_canonical(NEW.descendant_memory_ids)
    OR NOT public.omni_memory_deletion_ids_are_canonical(NEW.retrieval_trace_ids)
    OR NOT public.omni_memory_deletion_ids_are_canonical(NEW.graph_node_ids)
    OR NOT public.omni_memory_deletion_ids_are_canonical(NEW.graph_edge_ids)
    OR NEW.memory_id COLLATE "C" = ANY(NEW.descendant_memory_ids)
  THEN
    RAISE EXCEPTION 'Memory deletion receipt manifest ids are not canonical'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO manifest
  FROM public.omni_memory_deletion_manifest_v1(NEW.tenant_id, NEW.memory_id);

  IF NEW.descendant_memory_ids IS DISTINCT FROM manifest.descendant_memory_ids
  THEN
    RAISE EXCEPTION 'Memory deletion receipt descendant closure is stale'
      USING ERRCODE = '40001';
  END IF;

  IF NEW.retrieval_trace_ids IS DISTINCT FROM manifest.retrieval_trace_ids
    OR NEW.graph_node_ids IS DISTINCT FROM manifest.graph_node_ids
    OR NEW.graph_edge_ids IS DISTINCT FROM manifest.graph_edge_ids
  THEN
    RAISE EXCEPTION 'Memory deletion receipt derived lineage is stale'
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END
$function$;

-- A validated receipt deletes its derived rows, scrubs every descendant into
-- a forgotten shell stamped with the receipt's time, and revokes the agent
-- grants that touch the closure. The caller still scrubs the root in the same
-- transaction; the end-state check holds both to the receipt at commit.
CREATE OR REPLACE FUNCTION public.omni_apply_memory_deletion_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_system_scope TEXT :=
    pg_catalog.current_setting('omni.system_scope', TRUE);
  previous_system_reason TEXT :=
    pg_catalog.current_setting('omni.system_reason', TRUE);
  previous_deletion_lineage TEXT :=
    pg_catalog.current_setting('omni.memory_deletion_lineage', TRUE);
  deleted_row_count INTEGER;
BEGIN
  PERFORM pg_catalog.set_config('omni.system_scope', 'true', TRUE);
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    'memory deletion receipt application',
    TRUE
  );
  PERFORM pg_catalog.set_config('omni.memory_deletion_lineage', 'true', TRUE);

  DELETE FROM public.omni_memory_graph_edges edge
  WHERE edge.tenant_id = NEW.tenant_id
    AND edge.id = ANY(NEW.graph_edge_ids);
  GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
  IF deleted_row_count <> NEW.graph_edge_count THEN
    RAISE EXCEPTION 'Memory deletion graph-edge manifest changed'
      USING ERRCODE = '40001';
  END IF;

  DELETE FROM public.omni_memory_graph_nodes node
  WHERE node.tenant_id = NEW.tenant_id
    AND node.id = ANY(NEW.graph_node_ids);
  GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
  IF deleted_row_count <> NEW.graph_node_count THEN
    RAISE EXCEPTION 'Memory deletion graph-node manifest changed'
      USING ERRCODE = '40001';
  END IF;

  DELETE FROM public.omni_retrieval_traces trace
  WHERE trace.tenant_id = NEW.tenant_id
    AND trace.id = ANY(NEW.retrieval_trace_ids);
  GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
  IF deleted_row_count <> NEW.retrieval_trace_count THEN
    RAISE EXCEPTION 'Memory deletion trace manifest changed'
      USING ERRCODE = '40001';
  END IF;

  -- Two static statements, because embedding_vector exists only where the
  -- vector extension is installed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'public.omni_memories'::regclass
      AND attribute.attname = 'embedding_vector'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    UPDATE public.omni_memories memory
    SET title = '[forgotten]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[forgotten]',
        embedding = NULL,
        embedding_vector = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        claim_status = 'forgotten',
        forgotten_at = NEW.forgotten_at,
        updated_at = NEW.forgotten_at
    WHERE memory.tenant_id = NEW.tenant_id
      AND memory.id = ANY(NEW.descendant_memory_ids)
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
      );
  ELSE
    UPDATE public.omni_memories memory
    SET title = '[forgotten]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[forgotten]',
        embedding = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        claim_status = 'forgotten',
        forgotten_at = NEW.forgotten_at,
        updated_at = NEW.forgotten_at
    WHERE memory.tenant_id = NEW.tenant_id
      AND memory.id = ANY(NEW.descendant_memory_ids)
      AND (
        memory.title IS DISTINCT FROM '[forgotten]'
        OR memory.content IS DISTINCT FROM ''
        OR memory.tags IS DISTINCT FROM '{}'::TEXT[]
        OR memory.source IS DISTINCT FROM '[forgotten]'
        OR memory.embedding IS NOT NULL
        OR memory.evidence_refs IS DISTINCT FROM '{}'::TEXT[]
        OR memory.supersedes_id IS NOT NULL
        OR memory.contradiction_of_id IS NOT NULL
        OR memory.claim_status IS DISTINCT FROM 'forgotten'
        OR memory.forgotten_at IS NULL
      );
  END IF;

  DELETE FROM public.omni_agent_memory_grants memory_grant
  WHERE memory_grant.tenant_id = NEW.tenant_id
    AND (
      memory_grant.source_memory_id = ANY(NEW.blocked_memory_ids)
      OR memory_grant.target_memory_id = ANY(NEW.blocked_memory_ids)
    );

  PERFORM pg_catalog.set_config(
    'omni.system_scope',
    COALESCE(previous_system_scope, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    COALESCE(previous_system_reason, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.memory_deletion_lineage',
    COALESCE(previous_deletion_lineage, ''),
    TRUE
  );
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.omni_apply_memory_deletion_receipt()
FROM PUBLIC;

DROP TRIGGER IF EXISTS omni_memory_deletion_receipts_apply
  ON public.omni_memory_deletion_receipts;
CREATE TRIGGER omni_memory_deletion_receipts_apply
AFTER INSERT ON public.omni_memory_deletion_receipts
FOR EACH ROW
EXECUTE FUNCTION public.omni_apply_memory_deletion_receipt();

-- Descendants become forgotten shells stamped with their receipt's time,
-- either when the forget writes the receipt or later from the scrub worker.
CREATE OR REPLACE FUNCTION public.omni_enforce_memory_deletion_barrier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  referenced_memory_ids TEXT[];
  locked_memory_id TEXT;
  canonical_forget BOOLEAN := FALSE;
BEGIN
  -- Every memory mutation participates in the tenant graph lock before
  -- taking narrower memory locks. This serializes new transitive lineage
  -- with receipt closure snapshots and keeps lock order deterministic.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('memory-graph:' || NEW.tenant_id, 0)
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
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(NEW.tenant_id),
      pg_catalog.hashtext('memory:' || locked_memory_id)
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
      pg_catalog.to_jsonb(NEW) -> 'embedding_vector',
      'null'::JSONB
    ) = 'null'::JSONB
    AND EXISTS (
      SELECT 1
      FROM public.omni_memory_deletion_receipts receipt
      WHERE receipt.tenant_id = NEW.tenant_id
        AND receipt.memory_id = NEW.id
        AND receipt.forgotten_at = NEW.forgotten_at
    )
  THEN
    canonical_forget := TRUE;
  ELSIF TG_OP = 'UPDATE'
    AND NOT COALESCE(
      OLD.claim_status = 'forgotten'
      AND OLD.title = '[forgotten]'
      AND OLD.content = ''
      AND cardinality(OLD.tags) = 0
      AND OLD.source = '[forgotten]'
      AND OLD.embedding IS NULL
      AND cardinality(OLD.evidence_refs) = 0
      AND OLD.supersedes_id IS NULL
      AND OLD.contradiction_of_id IS NULL
      AND OLD.forgotten_at IS NOT NULL
      AND COALESCE(
        pg_catalog.to_jsonb(OLD) -> 'embedding_vector',
        'null'::JSONB
      ) = 'null'::JSONB,
      FALSE
    )
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
      pg_catalog.to_jsonb(NEW) -> 'embedding_vector',
      'null'::JSONB
    ) = 'null'::JSONB
    AND EXISTS (
      SELECT 1
      FROM public.omni_memory_deletion_receipts receipt
      WHERE receipt.tenant_id = NEW.tenant_id
        AND receipt.memory_id <> NEW.id
        AND receipt.blocked_memory_ids @> ARRAY[NEW.id]
        AND receipt.forgotten_at = NEW.forgotten_at
    )
  THEN
    canonical_forget := TRUE;
  END IF;

  IF public.omni_memory_ids_have_deletion_barrier(
    NEW.tenant_id,
    referenced_memory_ids
  ) AND NOT canonical_forget THEN
    RAISE EXCEPTION 'Memory write intersects a permanent deletion barrier'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_validate_canonical_memory_forget()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  final_memory public.omni_memories%ROWTYPE;
  final_referenced_memory_ids TEXT[];
  referenced_memory_id TEXT;
  canonical_shell BOOLEAN := FALSE;
  canonical_forget BOOLEAN := FALSE;
BEGIN
  -- Prefer the final stored row when it remains selectable. A row that a
  -- concurrently committed barrier now hides from RLS must still be
  -- rejected, so retain the queued NEW image as the fail-closed fallback.
  final_memory := NEW;
  SELECT stored_memory.*
  INTO final_memory
  FROM public.omni_memories stored_memory
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

  -- A private memory may cite a private memory of the same owner that this
  -- scope cannot read, such as the source of an agent share. Any other
  -- reference this scope cannot resolve is rejected.
  FOR referenced_memory_id IN
    SELECT reference.memory_id
    FROM unnest(final_referenced_memory_ids) reference(memory_id)
    WHERE reference.memory_id <> final_memory.id
      AND NOT EXISTS (
        SELECT 1
        FROM public.omni_memories target
        WHERE target.tenant_id = final_memory.tenant_id
          AND target.id = reference.memory_id
      )
  LOOP
    IF NOT COALESCE(
      final_memory.access_contract_version = 1
      AND final_memory.access_state = 'scope_bound'
      AND final_memory.visibility IN ('user_private', 'agent_private')
      AND public.omni_memory_reference_shares_owner_v1(
        final_memory.tenant_id,
        final_memory.owner_actor_id,
        referenced_memory_id
      ),
      FALSE
    ) THEN
      RAISE EXCEPTION
        'Memory lineage references an unknown or cross-tenant memory'
        USING ERRCODE = '23503';
    END IF;
  END LOOP;

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
      pg_catalog.to_jsonb(final_memory) -> 'embedding_vector',
      'null'::JSONB
    ) = 'null'::JSONB,
    FALSE
  );
  -- A descendant is canonical under the receipt whose closure scrubbed it.
  canonical_forget := canonical_shell AND EXISTS (
    SELECT 1
    FROM public.omni_memory_deletion_receipts receipt
    WHERE receipt.tenant_id = final_memory.tenant_id
      AND receipt.blocked_memory_ids @> ARRAY[final_memory.id]
      AND receipt.forgotten_at = final_memory.forgotten_at
  );

  IF public.omni_memory_ids_have_deletion_barrier(
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
$function$;

-- At commit a receipt must match the database: the root and every descendant
-- scrubbed, the derived rows gone, and no agent grant left on the closure.
-- Hidden descendants count, so the check looks past the deletion barrier.
CREATE OR REPLACE FUNCTION public.omni_validate_memory_deletion_receipt_end_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_system_scope TEXT :=
    pg_catalog.current_setting('omni.system_scope', TRUE);
  previous_system_reason TEXT :=
    pg_catalog.current_setting('omni.system_reason', TRUE);
  previous_deletion_lineage TEXT :=
    pg_catalog.current_setting('omni.memory_deletion_lineage', TRUE);
BEGIN
  PERFORM pg_catalog.set_config('omni.system_scope', 'true', TRUE);
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    'memory deletion receipt end-state validation',
    TRUE
  );
  PERFORM pg_catalog.set_config('omni.memory_deletion_lineage', 'true', TRUE);

  IF NOT EXISTS (
    SELECT 1
    FROM public.omni_memories memory
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
        pg_catalog.to_jsonb(memory) -> 'embedding_vector',
        'null'::JSONB
      ) = 'null'::JSONB
  ) THEN
    RAISE EXCEPTION 'Memory deletion receipt did not commit a canonical forget'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.omni_retrieval_traces trace
    WHERE trace.tenant_id = NEW.tenant_id
      AND trace.id = ANY(NEW.retrieval_trace_ids)
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_memory_graph_nodes node
    WHERE node.tenant_id = NEW.tenant_id
      AND node.id = ANY(NEW.graph_node_ids)
  ) OR EXISTS (
    SELECT 1
    FROM public.omni_memory_graph_edges edge
    WHERE edge.tenant_id = NEW.tenant_id
      AND edge.id = ANY(NEW.graph_edge_ids)
  ) THEN
    RAISE EXCEPTION
      'Memory deletion receipt retained rows from its derived manifest'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.omni_memories memory
    WHERE memory.tenant_id = NEW.tenant_id
      AND memory.id = ANY(NEW.descendant_memory_ids)
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
  ) THEN
    RAISE EXCEPTION 'Memory deletion receipt left a descendant unscrubbed'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.omni_agent_memory_grants memory_grant
    WHERE memory_grant.tenant_id = NEW.tenant_id
      AND (
        memory_grant.source_memory_id = ANY(NEW.blocked_memory_ids)
        OR memory_grant.target_memory_id = ANY(NEW.blocked_memory_ids)
      )
  ) THEN
    RAISE EXCEPTION 'Memory deletion receipt retained an agent memory grant'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config(
    'omni.system_scope',
    COALESCE(previous_system_scope, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    COALESCE(previous_system_reason, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.memory_deletion_lineage',
    COALESCE(previous_deletion_lineage, ''),
    TRUE
  );
  RETURN NEW;
END
$function$;

-- Grants stay append-only, except that a forget revokes the grants whose
-- source or copy is in its closure.
CREATE OR REPLACE FUNCTION public.omni_reject_agent_memory_grant_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' THEN
    IF public.omni_memory_ids_have_deletion_barrier(
      OLD.tenant_id,
      ARRAY[OLD.source_memory_id, OLD.target_memory_id]
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'Agent memory grants are append-only'
    USING ERRCODE = '55000';
END
$function$;

-- Lifecycle and promotion rows accept maintenance deletes only, so the scrub
-- raises system scope for its two statements.
CREATE OR REPLACE FUNCTION public.omni_scrub_memory_lifecycle_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_system_scope TEXT :=
    pg_catalog.current_setting('omni.system_scope', TRUE);
  previous_system_reason TEXT :=
    pg_catalog.current_setting('omni.system_reason', TRUE);
BEGIN
  PERFORM pg_catalog.set_config('omni.system_scope', 'true', TRUE);
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    'memory lifecycle lineage scrub',
    TRUE
  );

  DELETE FROM public.omni_memory_lifecycle_states lifecycle
  WHERE lifecycle.tenant_id = OLD.tenant_id
    AND lifecycle.memory_id = OLD.id;
  DELETE FROM public.omni_memory_promotion_reviews review
  WHERE review.tenant_id = OLD.tenant_id
    AND (
      OLD.id = ANY(review.source_memory_ids)
      OR review.promoted_memory_id = OLD.id
    );

  PERFORM pg_catalog.set_config(
    'omni.system_scope',
    COALESCE(previous_system_scope, ''),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'omni.system_reason',
    COALESCE(previous_system_reason, ''),
    TRUE
  );
  RETURN OLD;
END
$function$;

-- The scrub worker leases receipts whose descendants are not yet shells.
-- Those descendants are hidden by the deletion barrier, so the lease looks
-- past it.
CREATE OR REPLACE FUNCTION public.omni_lease_memory_deletion_scrub_receipts(
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
DECLARE
  previous_deletion_lineage TEXT :=
    pg_catalog.current_setting('omni.memory_deletion_lineage', TRUE);
BEGIN
  IF COALESCE(pg_catalog.current_setting('omni.system_scope', TRUE), '') <> 'true'
    OR NULLIF(pg_catalog.current_setting('omni.system_reason', TRUE), '') IS NULL
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

  PERFORM pg_catalog.set_config('omni.memory_deletion_lineage', 'true', TRUE);

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

  PERFORM pg_catalog.set_config(
    'omni.memory_deletion_lineage',
    COALESCE(previous_deletion_lineage, ''),
    TRUE
  );
  RETURN;
END
$function$;

DO $verify$
DECLARE
  schema_owner OID;
  expected RECORD;
  function_row RECORD;
BEGIN
  SELECT relation.relowner
  INTO schema_owner
  FROM pg_catalog.pg_class relation
  WHERE relation.oid = 'public.omni_schema_version'::regclass;

  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.omni_agent_private_memory_owner_forget_v1_allows(text,text)'::regprocedure,
          FALSE,
          'memory.forget.v1'
        ),
        (
          'public.omni_memory_reference_shares_owner_v1(text,text,text)'::regprocedure,
          TRUE,
          'omni.system_scope'
        ),
        (
          'public.omni_memory_deletion_manifest_v1(text,text)'::regprocedure,
          TRUE,
          'omni.memory_deletion_lineage'
        ),
        (
          'public.omni_validate_memory_deletion_receipt()'::regprocedure,
          FALSE,
          'omni_memory_deletion_manifest_v1'
        ),
        (
          'public.omni_apply_memory_deletion_receipt()'::regprocedure,
          TRUE,
          'omni.memory_deletion_lineage'
        ),
        (
          'public.omni_enforce_memory_deletion_barrier()'::regprocedure,
          FALSE,
          'blocked_memory_ids'
        ),
        (
          'public.omni_validate_canonical_memory_forget()'::regprocedure,
          FALSE,
          'omni_memory_reference_shares_owner_v1'
        ),
        (
          'public.omni_validate_memory_deletion_receipt_end_state()'::regprocedure,
          TRUE,
          'omni.memory_deletion_lineage'
        ),
        (
          'public.omni_reject_agent_memory_grant_mutation()'::regprocedure,
          FALSE,
          'omni_memory_ids_have_deletion_barrier'
        ),
        (
          'public.omni_scrub_memory_lifecycle_lineage()'::regprocedure,
          TRUE,
          'omni.system_scope'
        ),
        (
          'public.omni_lease_memory_deletion_scrub_receipts(integer)'::regprocedure,
          TRUE,
          'omni.memory_deletion_lineage'
        )
    ) AS expected_function(function_oid, security_definer, body_marker)
  LOOP
    SELECT procedure.prosecdef,
           procedure.prosrc,
           COALESCE(procedure.proconfig, '{}'::TEXT[]) AS proconfig,
           procedure.proowner
    INTO function_row
    FROM pg_catalog.pg_proc procedure
    WHERE procedure.oid = expected.function_oid;

    IF NOT FOUND
      OR function_row.prosecdef IS DISTINCT FROM expected.security_definer
      OR pg_catalog.strpos(function_row.prosrc, expected.body_marker) = 0
      OR NOT (
        'search_path=pg_catalog, public' = ANY(function_row.proconfig)
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(function_row.proconfig) setting
        WHERE setting LIKE 'omni.%'
      )
      OR (
        expected.security_definer
        AND function_row.proowner <> schema_owner
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles owner_role
          WHERE owner_role.oid = function_row.proowner
            AND owner_role.rolsuper
        )
      )
    THEN
      RAISE EXCEPTION 'Memory forget lineage closure is invalid'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc procedure
    WHERE procedure.oid =
        'public.omni_validate_memory_deletion_receipt()'::regprocedure
      AND procedure.prosrc LIKE '%DELETE FROM%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc procedure
    WHERE procedure.oid =
        'public.omni_validate_canonical_memory_forget()'::regprocedure
      AND procedure.prosrc LIKE '%blocked_memory_ids%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_record
    WHERE trigger_record.tgrelid =
        'public.omni_memory_deletion_receipts'::regclass
      AND trigger_record.tgname = 'omni_memory_deletion_receipts_apply'
      AND trigger_record.tgfoid =
        'public.omni_apply_memory_deletion_receipt()'::regprocedure
      AND trigger_record.tgenabled = 'O'
      AND NOT trigger_record.tgdeferrable
      AND trigger_record.tgtype = 5
      AND NOT trigger_record.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy memory_policy
    WHERE memory_policy.polrelid = 'public.omni_memories'::regclass
      AND memory_policy.polname = 'omni_memory_deletion_barrier'
      AND NOT memory_policy.polpermissive
      AND memory_policy.polcmd = 'r'
      AND pg_catalog.pg_get_expr(
        memory_policy.polqual,
        memory_policy.polrelid
      ) LIKE '%omni.memory_deletion_lineage%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy memory_policy
    WHERE memory_policy.polrelid = 'public.omni_memories'::regclass
      AND memory_policy.polname = 'omni_memory_access_scope_holdback'
      AND NOT memory_policy.polpermissive
      AND pg_catalog.pg_get_expr(
        memory_policy.polqual,
        memory_policy.polrelid
      ) LIKE '%omni_agent_private_memory_owner_forget_v1_allows%'
      AND pg_catalog.pg_get_expr(
        memory_policy.polwithcheck,
        memory_policy.polrelid
      ) LIKE '%omni_agent_private_memory_owner_forget_v1_allows%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )) privilege
    WHERE procedure.oid IN (
        'public.omni_memory_deletion_manifest_v1(text,text)'::regprocedure,
        'public.omni_apply_memory_deletion_receipt()'::regprocedure
      )
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles serving_role
    WHERE serving_role.rolname IN ('omni_runtime', 'omni_maintenance')
      AND NOT pg_catalog.has_function_privilege(
        serving_role.oid,
        'public.omni_memory_deletion_manifest_v1(text,text)',
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'Memory forget lineage closure is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  207,
  'memory_forget_lineage_closure_v1',
  '980dfe0af300eac5072cf0bf6b5f80b6a4e5335f444f0046732e7291f3f26c36',
  clock_timestamp()
);

COMMIT;
