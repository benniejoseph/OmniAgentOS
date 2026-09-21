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

  IF latest_version IS DISTINCT FROM 193 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 193
      AND name = 'execution_principal_row_validator_grant_v1'
      AND checksum = '9b787d1cfa1d6ae007cf8594f43c00045bab640b1f596e91d330923acc3bf2f7'
  ) <> 1 THEN
    RAISE EXCEPTION 'Moltbook autonomy predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- The original nine-tool connection remains valid. The only wider boundary is
-- the exact v2 community-reading/subscription surface; arbitrary extra tools,
-- Skills, broader memory, grants, or ungoverned execution remain impossible.
CREATE OR REPLACE FUNCTION omni_moltbook_agent_boundary_is_exact_v1(
  assigned_skill_ids TEXT[], assigned_tool_ids TEXT[], agent_memory_scope TEXT,
  agent_autonomy TEXT, agent_approval_policy TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    cardinality(assigned_skill_ids) = 0
    AND (
      (
        cardinality(assigned_tool_ids) = 9
        AND assigned_tool_ids @> ARRAY[
          'moltbook.home.read', 'moltbook.feed.read', 'moltbook.thread.read',
          'moltbook.post.create', 'moltbook.comment.create',
          'moltbook.post.vote', 'moltbook.comment.upvote',
          'moltbook.agent.follow', 'moltbook.verify'
        ]::TEXT[]
        AND assigned_tool_ids <@ ARRAY[
          'moltbook.home.read', 'moltbook.feed.read', 'moltbook.thread.read',
          'moltbook.post.create', 'moltbook.comment.create',
          'moltbook.post.vote', 'moltbook.comment.upvote',
          'moltbook.agent.follow', 'moltbook.verify'
        ]::TEXT[]
      ) OR (
        cardinality(assigned_tool_ids) = 13
        AND assigned_tool_ids @> ARRAY[
          'moltbook.home.read', 'moltbook.feed.read', 'moltbook.thread.read',
          'moltbook.post.create', 'moltbook.comment.create',
          'moltbook.post.vote', 'moltbook.comment.upvote',
          'moltbook.agent.follow', 'moltbook.verify',
          'moltbook.submolts.list', 'moltbook.submolt.read',
          'moltbook.submolt.feed', 'moltbook.submolt.subscribe'
        ]::TEXT[]
        AND assigned_tool_ids <@ ARRAY[
          'moltbook.home.read', 'moltbook.feed.read', 'moltbook.thread.read',
          'moltbook.post.create', 'moltbook.comment.create',
          'moltbook.post.vote', 'moltbook.comment.upvote',
          'moltbook.agent.follow', 'moltbook.verify',
          'moltbook.submolts.list', 'moltbook.submolt.read',
          'moltbook.submolt.feed', 'moltbook.submolt.subscribe'
        ]::TEXT[]
      )
    )
    AND agent_memory_scope = 'session'
    AND agent_autonomy = 'governed'
    AND agent_approval_policy IN ('risk_based', 'always'),
    FALSE
  )
$function$;

CREATE TABLE omni_moltbook_authority_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  authority_version BIGINT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_generation BIGINT NOT NULL,
  principal_sha256 TEXT NOT NULL,
  definition_version BIGINT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  policy_boundary_sha256 TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  change_request_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, authority_version),
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id)
    REFERENCES omni_moltbook_connections (tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id, principal_generation)
    REFERENCES omni_tenant_execution_principals (
      tenant_id, principal_id, principal_generation
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_id, definition_version)
    REFERENCES omni_agent_definition_versions (
      tenant_id, agent_definition_id, definition_version
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_authority_[a-f0-9]{48}$'),
  CHECK (authority_version BETWEEN 1 AND 9007199254740991),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (char_length(principal_id) BETWEEN 1 AND 240),
  CHECK (principal_generation BETWEEN 1 AND 9007199254740991),
  CHECK (principal_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (definition_version BETWEEN 1 AND 9007199254740991),
  CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (policy_boundary_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (change_reason IN ('initial_connection', 'agent_rebind')),
  CHECK (change_request_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE omni_moltbook_autonomy_enrollments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  enrollment_version BIGINT NOT NULL,
  authority_id TEXT NOT NULL,
  authority_version BIGINT NOT NULL,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  charter_sha256 TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  authorized_by_actor_id TEXT NOT NULL,
  cycle_interval_seconds INTEGER NOT NULL,
  cycle_post_limit INTEGER NOT NULL,
  cycle_comment_limit INTEGER NOT NULL,
  cycle_vote_limit INTEGER NOT NULL,
  cycle_follow_limit INTEGER NOT NULL,
  cycle_subscribe_limit INTEGER NOT NULL,
  daily_post_limit INTEGER NOT NULL,
  daily_comment_limit INTEGER NOT NULL,
  daily_vote_limit INTEGER NOT NULL,
  daily_follow_limit INTEGER NOT NULL,
  daily_subscribe_limit INTEGER NOT NULL,
  next_cycle_at TIMESTAMPTZ NOT NULL,
  last_cycle_at TIMESTAMPTZ,
  enabled_at TIMESTAMPTZ NOT NULL,
  last_paused_at TIMESTAMPTZ,
  last_resumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, enrollment_version),
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id)
    REFERENCES omni_moltbook_connections (tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) REFERENCES omni_moltbook_authority_versions (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id, authority_id)
    REFERENCES omni_moltbook_authority_versions (
      tenant_id, owner_actor_id, connection_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (authorized_by_actor_id)
    REFERENCES omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_enrollment_[a-f0-9]{48}$'),
  CHECK (enrollment_version BETWEEN 1 AND 9007199254740991),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (authority_version BETWEEN 1 AND 9007199254740991),
  CHECK (status IN ('enabled', 'paused', 'revoked')),
  CHECK (policy_version = 'moltbook-autonomy-v1'),
  CHECK (charter_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (disclosure_version = 'moltbook-autonomy-public-actions-v1'),
  CHECK (cycle_interval_seconds BETWEEN 14400 AND 86400),
  CHECK (cycle_post_limit BETWEEN 0 AND 1),
  CHECK (cycle_comment_limit BETWEEN 0 AND 2),
  CHECK (cycle_vote_limit BETWEEN 0 AND 4),
  CHECK (cycle_follow_limit BETWEEN 0 AND 1),
  CHECK (cycle_subscribe_limit BETWEEN 0 AND 1),
  CHECK (daily_post_limit BETWEEN 0 AND 1),
  CHECK (daily_comment_limit BETWEEN 0 AND 6),
  CHECK (daily_vote_limit BETWEEN 0 AND 12),
  CHECK (daily_follow_limit BETWEEN 0 AND 2),
  CHECK (daily_subscribe_limit BETWEEN 0 AND 2),
  CHECK (next_cycle_at >= created_at),
  CHECK (last_cycle_at IS NULL OR last_cycle_at >= created_at),
  CHECK (last_paused_at IS NULL OR last_paused_at >= created_at),
  CHECK (last_resumed_at IS NULL OR last_resumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX omni_moltbook_autonomy_enrollments_current_idx
  ON omni_moltbook_autonomy_enrollments (
    tenant_id, owner_actor_id, connection_id
  ) WHERE status <> 'revoked';
CREATE INDEX omni_moltbook_autonomy_enrollments_due_idx
  ON omni_moltbook_autonomy_enrollments (
    status, next_cycle_at, tenant_id, connection_id
  ) WHERE status = 'enabled';

CREATE TABLE omni_moltbook_autonomy_cycles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  enrollment_version BIGINT NOT NULL,
  authority_version BIGINT NOT NULL,
  trigger_kind TEXT NOT NULL,
  execution_purpose TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  membership_role TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  agent_run_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  outcome_sha256 TEXT,
  summary_sha256 TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  FOREIGN KEY (
    tenant_id, owner_actor_id, connection_id, enrollment_version
  ) REFERENCES omni_moltbook_autonomy_enrollments (
    tenant_id, owner_actor_id, connection_id, enrollment_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id, enrollment_id)
    REFERENCES omni_moltbook_autonomy_enrollments (
      tenant_id, owner_actor_id, connection_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) REFERENCES omni_moltbook_authority_versions (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_cycle_[a-f0-9]{48}$'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (enrollment_version BETWEEN 1 AND 9007199254740991),
  CHECK (authority_version BETWEEN 1 AND 9007199254740991),
  CHECK (trigger_kind IN ('scheduled', 'owner_requested')),
  CHECK (execution_purpose = 'moltbook.autonomy.cycle.v1'),
  CHECK (correlation_id = id),
  CHECK (status IN ('claimed', 'running', 'succeeded', 'failed')),
  CHECK (membership_role IN ('operator', 'admin')),
  CHECK (char_length(lease_owner) BETWEEN 1 AND 160),
  CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (lease_expires_at > claimed_at),
  CHECK (char_length(agent_run_id) BETWEEN 1 AND 240 OR agent_run_id IS NULL),
  CHECK (outcome_sha256 ~ '^[a-f0-9]{64}$' OR outcome_sha256 IS NULL),
  CHECK (summary_sha256 ~ '^[a-f0-9]{64}$' OR summary_sha256 IS NULL),
  CHECK (error_code ~ '^[a-z0-9_.:-]{1,80}$' OR error_code IS NULL),
  CHECK ((status = 'running') = (agent_run_id IS NOT NULL AND started_at IS NOT NULL)
    OR status IN ('succeeded', 'failed')),
  CHECK (status <> 'claimed' OR (agent_run_id IS NULL AND started_at IS NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK (
    status IN ('succeeded', 'failed')
    OR (outcome_sha256 IS NULL AND summary_sha256 IS NULL AND error_code IS NULL)
  ),
  CHECK (status <> 'succeeded' OR (outcome_sha256 IS NOT NULL AND error_code IS NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX omni_moltbook_autonomy_cycles_active_idx
  ON omni_moltbook_autonomy_cycles (
    tenant_id, owner_actor_id, enrollment_id
  ) WHERE status IN ('claimed', 'running');
CREATE INDEX omni_moltbook_autonomy_cycles_history_idx
  ON omni_moltbook_autonomy_cycles (
    tenant_id, owner_actor_id, connection_id, created_at DESC, id DESC
  );

CREATE TABLE omni_moltbook_autonomy_action_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  authority_version BIGINT NOT NULL,
  execution_purpose TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_input_sha256 TEXT NOT NULL,
  effect_target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  claim_token_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  tool_execution_id TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  UNIQUE (tenant_id, owner_actor_id, connection_id, idempotency_key),
  UNIQUE (tenant_id, owner_actor_id, cycle_id, tool_id, tool_input_sha256, effect_target_id),
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id, enrollment_id)
    REFERENCES omni_moltbook_autonomy_enrollments (
      tenant_id, owner_actor_id, connection_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id, cycle_id)
    REFERENCES omni_moltbook_autonomy_cycles (
      tenant_id, owner_actor_id, connection_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) REFERENCES omni_moltbook_authority_versions (
    tenant_id, owner_actor_id, connection_id, authority_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_action_[a-f0-9]{48}$'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (char_length(agent_run_id) BETWEEN 1 AND 240),
  CHECK (execution_purpose = 'moltbook.autonomy.cycle.v1'),
  CHECK (correlation_id = cycle_id),
  CHECK (action_kind IN ('post', 'comment', 'vote', 'follow', 'subscribe')),
  CHECK (tool_id IN (
    'moltbook.post.create', 'moltbook.comment.create',
    'moltbook.post.vote', 'moltbook.comment.upvote',
    'moltbook.agent.follow', 'moltbook.submolt.subscribe'
  )),
  CHECK (
    (action_kind = 'post' AND tool_id = 'moltbook.post.create') OR
    (action_kind = 'comment' AND tool_id = 'moltbook.comment.create') OR
    (action_kind = 'vote' AND tool_id IN ('moltbook.post.vote', 'moltbook.comment.upvote')) OR
    (action_kind = 'follow' AND tool_id = 'moltbook.agent.follow') OR
    (action_kind = 'subscribe' AND tool_id = 'moltbook.submolt.subscribe')
  ),
  CHECK (tool_input_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (effect_target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'),
  CHECK (char_length(idempotency_key) BETWEEN 16 AND 240),
  CHECK (idempotency_key !~ '[[:space:]]'),
  CHECK (claim_token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (status IN ('claimed', 'consumed')),
  CHECK (expires_at > claimed_at AND expires_at <= claimed_at + INTERVAL '10 minutes'),
  CHECK ((status = 'consumed') = (tool_execution_id IS NOT NULL AND consumed_at IS NOT NULL)),
  CHECK (tool_execution_id IS NULL OR char_length(tool_execution_id) BETWEEN 1 AND 240),
  CHECK (consumed_at IS NULL OR (consumed_at >= claimed_at AND consumed_at <= expires_at))
);

CREATE INDEX omni_moltbook_autonomy_action_budget_idx
  ON omni_moltbook_autonomy_action_claims (
    tenant_id, owner_actor_id, connection_id, action_kind, claimed_at DESC
  );

CREATE TABLE omni_moltbook_interest_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  score NUMERIC(5,4) NOT NULL,
  confidence NUMERIC(5,4) NOT NULL,
  active BOOLEAN NOT NULL,
  evidence_sha256s TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  UNIQUE (tenant_id, owner_actor_id, cycle_id, topic),
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id, cycle_id)
    REFERENCES omni_moltbook_autonomy_cycles (
      tenant_id, owner_actor_id, connection_id, id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_interest_[a-f0-9]{48}$'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (topic = lower(btrim(topic))),
  CHECK (topic ~ '^[a-z0-9][a-z0-9 ._+/#-]{0,63}$'),
  CHECK (score BETWEEN 0 AND 1),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (cardinality(evidence_sha256s) BETWEEN 1 AND 8),
  CHECK (
    array_to_string(evidence_sha256s, ',') ~
      '^[a-f0-9]{64}(,[a-f0-9]{64}){0,7}$'
  )
);

CREATE INDEX omni_moltbook_interest_projection_idx
  ON omni_moltbook_interest_observations (
    tenant_id, owner_actor_id, connection_id, topic, created_at DESC, id DESC
  );

CREATE TABLE omni_moltbook_autonomy_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enrollment_id TEXT,
  cycle_id TEXT,
  action_claim_id TEXT,
  payload_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, owner_actor_id, connection_id, id),
  FOREIGN KEY (tenant_id, owner_actor_id, connection_id)
    REFERENCES omni_moltbook_connections (tenant_id, owner_actor_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (id ~ '^moltbook_event_[a-f0-9]{48}$'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 240),
  CHECK (event_type IN (
    'moltbook.autonomy.authority.bound',
    'moltbook.autonomy.enrollment.enabled',
    'moltbook.autonomy.enrollment.paused',
    'moltbook.autonomy.enrollment.resumed',
    'moltbook.autonomy.enrollment.revoked',
    'moltbook.autonomy.cycle.claimed',
    'moltbook.autonomy.cycle.started',
    'moltbook.autonomy.cycle.completed',
    'moltbook.autonomy.action.claimed',
    'moltbook.autonomy.action.consumed',
    'moltbook.autonomy.interests.updated'
  )),
  CHECK (enrollment_id IS NULL OR enrollment_id ~ '^moltbook_enrollment_[a-f0-9]{48}$'),
  CHECK (cycle_id IS NULL OR cycle_id ~ '^moltbook_cycle_[a-f0-9]{48}$'),
  CHECK (action_claim_id IS NULL OR action_claim_id ~ '^moltbook_action_[a-f0-9]{48}$'),
  CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX omni_moltbook_autonomy_events_cursor_idx
  ON omni_moltbook_autonomy_events (
    tenant_id, owner_actor_id, connection_id, created_at DESC, id DESC
  );

CREATE FUNCTION omni_validate_moltbook_authority_version_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE expected_version BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('moltbook-authority:' || NEW.tenant_id || ':' || NEW.connection_id, 0)
  );
  SELECT COALESCE(MAX(authority_version), 0) + 1 INTO expected_version
  FROM public.omni_moltbook_authority_versions
  WHERE tenant_id = NEW.tenant_id
    AND owner_actor_id = NEW.owner_actor_id
    AND connection_id = NEW.connection_id;
  IF NEW.authority_version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'Moltbook authority version is not next'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.authority_version = 1 AND NOT EXISTS (
    SELECT 1 FROM public.omni_moltbook_connections connection
    WHERE connection.tenant_id = NEW.tenant_id
      AND connection.owner_actor_id = NEW.owner_actor_id
      AND connection.id = NEW.connection_id
      AND connection.agent_id = NEW.agent_id
      AND connection.principal_id = NEW.principal_id
      AND connection.principal_generation = NEW.principal_generation
      AND connection.principal_sha256 = NEW.principal_sha256
      AND connection.definition_version = NEW.definition_version
      AND connection.definition_sha256 = NEW.definition_sha256
      AND connection.policy_boundary_sha256 = NEW.policy_boundary_sha256
      AND NEW.change_reason = 'initial_connection'
  ) THEN
    RAISE EXCEPTION 'Initial Moltbook authority does not match its connection pin'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.authority_version > 1 AND NEW.change_reason <> 'agent_rebind' THEN
    RAISE EXCEPTION 'Later Moltbook authority must be an explicit Agent rebind'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.omni_moltbook_connections connection
    JOIN public.omni_custom_agents agent
      ON agent.tenant_id = connection.tenant_id
      AND agent.actor_id = connection.owner_actor_id
      AND agent.id = connection.agent_id
    JOIN public.omni_tenant_execution_principals principal
      ON principal.tenant_id = connection.tenant_id
      AND principal.principal_id = NEW.principal_id
      AND principal.principal_generation = NEW.principal_generation
    JOIN public.omni_agent_principal_policies policy
      ON policy.tenant_id = principal.tenant_id
      AND policy.principal_id = principal.principal_id
      AND policy.principal_generation = principal.principal_generation
    JOIN public.omni_auth_user_actor_identifiers owner_identifier
      ON owner_identifier.actor_identifier COLLATE "C" =
        connection.owner_actor_id COLLATE "C"
      AND owner_identifier.canonical_actor_id = principal.controller_actor_id
    WHERE connection.tenant_id = NEW.tenant_id
      AND connection.owner_actor_id = NEW.owner_actor_id
      AND connection.id = NEW.connection_id
      AND connection.agent_id = NEW.agent_id
      AND connection.status <> 'revoked'
      AND principal.agent_definition_id = NEW.agent_id
      AND principal.principal_kind = 'agent'
      AND principal.state = 'active'
      AND policy.owner_actor_id = principal.controller_actor_id
      AND policy.agent_definition_id = NEW.agent_id
      AND policy.agent_definition_version = NEW.definition_version
      AND policy.authority_mode = 'explicit_grants'
      AND (policy.expires_at IS NULL OR policy.expires_at > statement_timestamp())
      AND agent.status IN ('ready', 'learning')
      AND NEW.definition_version = (
        SELECT MAX(current_definition.definition_version)
        FROM public.omni_agent_definition_versions current_definition
        WHERE current_definition.tenant_id = NEW.tenant_id
          AND current_definition.agent_definition_id = NEW.agent_id
      )
      AND cardinality(policy.context_grant_ids) = 0
      AND cardinality(policy.capability_grant_ids) = 0
      AND public.omni_moltbook_agent_boundary_is_exact_v1(
        agent.skill_ids, agent.tool_ids, agent.memory_scope,
        agent.autonomy, agent.approval_policy
      )
      AND public.omni_moltbook_agent_boundary_is_exact_v1(
        ARRAY[]::TEXT[], policy.tool_grant_ids, policy.memory_scope,
        policy.autonomy, policy.approval_policy
      )
  ) THEN
    RAISE EXCEPTION 'Moltbook authority is not the current exact Agent boundary'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_validate_moltbook_enrollment_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE expected_version BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('moltbook-enrollment:' || NEW.tenant_id || ':' || NEW.connection_id, 0)
  );
  SELECT COALESCE(MAX(enrollment_version), 0) + 1 INTO expected_version
  FROM public.omni_moltbook_autonomy_enrollments
  WHERE tenant_id = NEW.tenant_id
    AND owner_actor_id = NEW.owner_actor_id
    AND connection_id = NEW.connection_id;
  IF NEW.enrollment_version IS DISTINCT FROM expected_version OR NEW.status <> 'enabled' THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollment must start as the next enabled version'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.omni_moltbook_authority_versions authority
    JOIN public.omni_moltbook_connections connection
      ON connection.tenant_id = authority.tenant_id
      AND connection.owner_actor_id = authority.owner_actor_id
      AND connection.id = authority.connection_id
    JOIN public.omni_tenant_execution_principals principal
      ON principal.tenant_id = authority.tenant_id
      AND principal.principal_id = authority.principal_id
      AND principal.principal_generation = authority.principal_generation
    JOIN public.omni_agent_principal_policies policy
      ON policy.tenant_id = principal.tenant_id
      AND policy.principal_id = principal.principal_id
      AND policy.principal_generation = principal.principal_generation
    JOIN public.omni_custom_agents agent
      ON agent.tenant_id = authority.tenant_id
      AND agent.actor_id = authority.owner_actor_id
      AND agent.id = authority.agent_id
    WHERE authority.tenant_id = NEW.tenant_id
      AND authority.owner_actor_id = NEW.owner_actor_id
      AND authority.connection_id = NEW.connection_id
      AND authority.id = NEW.authority_id
      AND authority.authority_version = NEW.authority_version
      AND authority.agent_id = NEW.agent_id
      AND authority.authority_version = (
        SELECT MAX(current_authority.authority_version)
        FROM public.omni_moltbook_authority_versions current_authority
        WHERE current_authority.tenant_id = NEW.tenant_id
          AND current_authority.owner_actor_id = NEW.owner_actor_id
          AND current_authority.connection_id = NEW.connection_id
      )
      AND connection.status = 'claimed'
      AND connection.claim_state = 'claimed'
      AND principal.principal_kind = 'agent'
      AND principal.agent_definition_id = NEW.agent_id
      AND principal.state = 'active'
      AND policy.owner_actor_id = principal.controller_actor_id
      AND policy.agent_definition_id = NEW.agent_id
      AND policy.agent_definition_version = authority.definition_version
      AND policy.authority_mode = 'explicit_grants'
      AND (policy.expires_at IS NULL OR policy.expires_at > statement_timestamp())
      AND cardinality(policy.context_grant_ids) = 0
      AND cardinality(policy.capability_grant_ids) = 0
      AND agent.status IN ('ready', 'learning')
      AND authority.definition_version = (
        SELECT MAX(current_definition.definition_version)
        FROM public.omni_agent_definition_versions current_definition
        WHERE current_definition.tenant_id = NEW.tenant_id
          AND current_definition.agent_definition_id = NEW.agent_id
      )
      AND public.omni_moltbook_agent_boundary_is_exact_v1(
        agent.skill_ids, agent.tool_ids, agent.memory_scope,
        agent.autonomy, agent.approval_policy
      )
      AND public.omni_moltbook_agent_boundary_is_exact_v1(
        ARRAY[]::TEXT[], policy.tool_grant_ids, policy.memory_scope,
        policy.autonomy, policy.approval_policy
      )
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollment authority is stale or unavailable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.omni_auth_user_actor_identifiers identifier
    WHERE identifier.actor_identifier COLLATE "C" = NEW.owner_actor_id COLLATE "C"
      AND identifier.canonical_actor_id = NEW.authorized_by_actor_id
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollment was not authorized by its owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_protect_moltbook_enrollment_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollments cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.connection_id IS DISTINCT FROM NEW.connection_id
    OR OLD.enrollment_version IS DISTINCT FROM NEW.enrollment_version
    OR OLD.authority_id IS DISTINCT FROM NEW.authority_id
    OR OLD.authority_version IS DISTINCT FROM NEW.authority_version
    OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
    OR OLD.charter_sha256 IS DISTINCT FROM NEW.charter_sha256
    OR OLD.disclosure_version IS DISTINCT FROM NEW.disclosure_version
    OR OLD.authorized_by_actor_id IS DISTINCT FROM NEW.authorized_by_actor_id
    OR OLD.cycle_interval_seconds IS DISTINCT FROM NEW.cycle_interval_seconds
    OR OLD.cycle_post_limit IS DISTINCT FROM NEW.cycle_post_limit
    OR OLD.cycle_comment_limit IS DISTINCT FROM NEW.cycle_comment_limit
    OR OLD.cycle_vote_limit IS DISTINCT FROM NEW.cycle_vote_limit
    OR OLD.cycle_follow_limit IS DISTINCT FROM NEW.cycle_follow_limit
    OR OLD.cycle_subscribe_limit IS DISTINCT FROM NEW.cycle_subscribe_limit
    OR OLD.daily_post_limit IS DISTINCT FROM NEW.daily_post_limit
    OR OLD.daily_comment_limit IS DISTINCT FROM NEW.daily_comment_limit
    OR OLD.daily_vote_limit IS DISTINCT FROM NEW.daily_vote_limit
    OR OLD.daily_follow_limit IS DISTINCT FROM NEW.daily_follow_limit
    OR OLD.daily_subscribe_limit IS DISTINCT FROM NEW.daily_subscribe_limit
    OR OLD.enabled_at IS DISTINCT FROM NEW.enabled_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollment authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'enabled' AND NEW.status IN ('enabled', 'paused', 'revoked'))
    OR (OLD.status = 'paused' AND NEW.status IN ('paused', 'enabled', 'revoked'))
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy enrollment lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = NEW.status AND (
    OLD.last_paused_at IS DISTINCT FROM NEW.last_paused_at
    OR OLD.last_resumed_at IS DISTINCT FROM NEW.last_resumed_at
    OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy lifecycle receipts cannot change without a transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'paused' AND NEW.status = 'enabled'
    AND (NEW.last_resumed_at IS NULL OR NEW.last_resumed_at <= COALESCE(OLD.last_resumed_at, OLD.created_at))
  THEN
    RAISE EXCEPTION 'Moltbook autonomy resume receipt is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'enabled' AND NEW.status = 'paused'
    AND (NEW.last_paused_at IS NULL OR NEW.last_paused_at <= COALESCE(OLD.last_paused_at, OLD.created_at))
  THEN
    RAISE EXCEPTION 'Moltbook autonomy pause receipt is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'enabled' AND NEW.status = 'paused' AND (
    OLD.last_resumed_at IS DISTINCT FROM NEW.last_resumed_at
    OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy pause changed unrelated lifecycle receipts'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'paused' AND NEW.status = 'enabled' AND (
    OLD.last_paused_at IS DISTINCT FROM NEW.last_paused_at
    OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy resume changed unrelated lifecycle receipts'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_protect_moltbook_cycle_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Moltbook autonomy cycles cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.connection_id IS DISTINCT FROM NEW.connection_id
    OR OLD.enrollment_id IS DISTINCT FROM NEW.enrollment_id
    OR OLD.enrollment_version IS DISTINCT FROM NEW.enrollment_version
    OR OLD.authority_version IS DISTINCT FROM NEW.authority_version
    OR OLD.trigger_kind IS DISTINCT FROM NEW.trigger_kind
    OR OLD.execution_purpose IS DISTINCT FROM NEW.execution_purpose
    OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
    OR OLD.scheduled_for IS DISTINCT FROM NEW.scheduled_for
    OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
    OR OLD.membership_role IS DISTINCT FROM NEW.membership_role
    OR OLD.lease_owner IS DISTINCT FROM NEW.lease_owner
    OR OLD.lease_token_sha256 IS DISTINCT FROM NEW.lease_token_sha256
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'Moltbook autonomy cycle authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'claimed' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy cycle lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'claimed' AND NEW.status = 'failed' AND (
    OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
  ) THEN
    RAISE EXCEPTION 'Failed unstarted Moltbook autonomy cycle changed its run binding'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'running' AND (
    OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
  ) THEN
    RAISE EXCEPTION 'Moltbook autonomy cycle run binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Completed Moltbook autonomy cycles are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_protect_moltbook_action_claim_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Moltbook autonomy action claims cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
    OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.connection_id IS DISTINCT FROM NEW.connection_id
    OR OLD.enrollment_id IS DISTINCT FROM NEW.enrollment_id
    OR OLD.cycle_id IS DISTINCT FROM NEW.cycle_id
    OR OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id
    OR OLD.authority_version IS DISTINCT FROM NEW.authority_version
    OR OLD.execution_purpose IS DISTINCT FROM NEW.execution_purpose
    OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
    OR OLD.action_kind IS DISTINCT FROM NEW.action_kind
    OR OLD.tool_id IS DISTINCT FROM NEW.tool_id
    OR OLD.tool_input_sha256 IS DISTINCT FROM NEW.tool_input_sha256
    OR OLD.effect_target_id IS DISTINCT FROM NEW.effect_target_id
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.claim_token_sha256 IS DISTINCT FROM NEW.claim_token_sha256
    OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.status <> 'claimed'
    OR NEW.status <> 'consumed'
  THEN
    RAISE EXCEPTION 'Moltbook autonomy action claim is immutable or already consumed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Moltbook autonomy authority, interests, and events are append-only'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION omni_validate_moltbook_interest_observation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE active_count INTEGER;
DECLARE topic_is_active BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('moltbook-interests:' || NEW.tenant_id || ':' || NEW.connection_id, 0)
  );
  SELECT observation.active INTO topic_is_active
  FROM public.omni_moltbook_interest_observations observation
  WHERE observation.tenant_id = NEW.tenant_id
    AND observation.owner_actor_id = NEW.owner_actor_id
    AND observation.connection_id = NEW.connection_id
    AND observation.topic = NEW.topic
  ORDER BY observation.created_at DESC, observation.id DESC
  LIMIT 1;
  SELECT count(*) INTO active_count
  FROM (
    SELECT DISTINCT ON (observation.topic) observation.topic, observation.active
    FROM public.omni_moltbook_interest_observations observation
    WHERE observation.tenant_id = NEW.tenant_id
      AND observation.owner_actor_id = NEW.owner_actor_id
      AND observation.connection_id = NEW.connection_id
    ORDER BY observation.topic, observation.created_at DESC, observation.id DESC
  ) latest
  WHERE latest.active;
  IF NEW.active AND NOT COALESCE(topic_is_active, FALSE) AND active_count >= 32 THEN
    RAISE EXCEPTION 'Moltbook interest profile cannot exceed 32 active topics'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.omni_moltbook_autonomy_cycles cycle
    WHERE cycle.tenant_id = NEW.tenant_id
      AND cycle.owner_actor_id = NEW.owner_actor_id
      AND cycle.connection_id = NEW.connection_id
      AND cycle.id = NEW.cycle_id
      AND cycle.agent_id = NEW.agent_id
      AND cycle.status IN ('running', 'succeeded')
  ) THEN
    RAISE EXCEPTION 'Moltbook interest evidence is not bound to a valid autonomy cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO omni_moltbook_authority_versions (
  id, tenant_id, owner_actor_id, agent_id, connection_id, authority_version,
  principal_id, principal_generation, principal_sha256,
  definition_version, definition_sha256, policy_boundary_sha256,
  change_reason, change_request_sha256, created_at
)
SELECT
  'moltbook_authority_' || substring(
    md5(connection.tenant_id || ':' || connection.id || ':1') ||
    md5(connection.registration_request_sha256), 1, 48
  ),
  connection.tenant_id, connection.owner_actor_id, connection.agent_id,
  connection.id, 1, connection.principal_id, connection.principal_generation,
  connection.principal_sha256, connection.definition_version,
  connection.definition_sha256, connection.policy_boundary_sha256,
  'initial_connection', connection.registration_request_sha256,
  connection.created_at
FROM omni_moltbook_connections connection;

CREATE TRIGGER omni_moltbook_authority_versions_validate
  BEFORE INSERT ON omni_moltbook_authority_versions
  FOR EACH ROW EXECUTE FUNCTION omni_validate_moltbook_authority_version_v1();
CREATE TRIGGER omni_moltbook_authority_versions_immutable
  BEFORE UPDATE OR DELETE ON omni_moltbook_authority_versions
  FOR EACH ROW EXECUTE FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1();
CREATE TRIGGER omni_moltbook_enrollments_validate
  BEFORE INSERT ON omni_moltbook_autonomy_enrollments
  FOR EACH ROW EXECUTE FUNCTION omni_validate_moltbook_enrollment_v1();
CREATE TRIGGER omni_moltbook_enrollments_protect
  BEFORE UPDATE OR DELETE ON omni_moltbook_autonomy_enrollments
  FOR EACH ROW EXECUTE FUNCTION omni_protect_moltbook_enrollment_v1();
CREATE TRIGGER omni_moltbook_cycles_protect
  BEFORE UPDATE OR DELETE ON omni_moltbook_autonomy_cycles
  FOR EACH ROW EXECUTE FUNCTION omni_protect_moltbook_cycle_v1();
CREATE TRIGGER omni_moltbook_action_claims_protect
  BEFORE UPDATE OR DELETE ON omni_moltbook_autonomy_action_claims
  FOR EACH ROW EXECUTE FUNCTION omni_protect_moltbook_action_claim_v1();
CREATE TRIGGER omni_moltbook_interest_observations_validate
  BEFORE INSERT ON omni_moltbook_interest_observations
  FOR EACH ROW EXECUTE FUNCTION omni_validate_moltbook_interest_observation_v1();
CREATE TRIGGER omni_moltbook_interest_observations_immutable
  BEFORE UPDATE OR DELETE ON omni_moltbook_interest_observations
  FOR EACH ROW EXECUTE FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1();
CREATE TRIGGER omni_moltbook_autonomy_events_immutable
  BEFORE UPDATE OR DELETE ON omni_moltbook_autonomy_events
  FOR EACH ROW EXECUTE FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1();

DO $no_truncate$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_moltbook_authority_versions',
    'omni_moltbook_autonomy_enrollments',
    'omni_moltbook_autonomy_cycles',
    'omni_moltbook_autonomy_action_claims',
    'omni_moltbook_interest_observations',
    'omni_moltbook_autonomy_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1()',
      table_name || '_no_truncate', table_name
    );
  END LOOP;
END
$no_truncate$;

DO $policies$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'omni_moltbook_authority_versions',
    'omni_moltbook_autonomy_enrollments',
    'omni_moltbook_autonomy_cycles',
    'omni_moltbook_autonomy_action_claims',
    'omni_moltbook_interest_observations',
    'omni_moltbook_autonomy_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY omni_tenant_isolation ON %I AS PERMISSIVE FOR ALL TO PUBLIC USING (omni_tenant_visible(tenant_id)) WITH CHECK (omni_tenant_visible(tenant_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$policies$;

REVOKE ALL ON omni_moltbook_authority_versions FROM PUBLIC;
REVOKE ALL ON omni_moltbook_autonomy_enrollments FROM PUBLIC;
REVOKE ALL ON omni_moltbook_autonomy_cycles FROM PUBLIC;
REVOKE ALL ON omni_moltbook_autonomy_action_claims FROM PUBLIC;
REVOKE ALL ON omni_moltbook_interest_observations FROM PUBLIC;
REVOKE ALL ON omni_moltbook_autonomy_events FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_validate_moltbook_authority_version_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_validate_moltbook_enrollment_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_moltbook_enrollment_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_moltbook_cycle_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_moltbook_action_claim_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_reject_moltbook_autonomy_append_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_validate_moltbook_interest_observation_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    GRANT SELECT, INSERT ON omni_moltbook_authority_versions TO omni_runtime;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_enrollments TO omni_runtime;
    GRANT UPDATE (
      status, next_cycle_at, last_cycle_at, last_paused_at,
      last_resumed_at, revoked_at, updated_at
    ) ON omni_moltbook_autonomy_enrollments TO omni_runtime;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_cycles TO omni_runtime;
    GRANT UPDATE (
      status, lease_expires_at, agent_run_id, started_at, completed_at,
      outcome_sha256, summary_sha256, error_code, updated_at
    ) ON omni_moltbook_autonomy_cycles TO omni_runtime;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_action_claims TO omni_runtime;
    GRANT UPDATE (status, tool_execution_id, consumed_at)
      ON omni_moltbook_autonomy_action_claims TO omni_runtime;
    GRANT SELECT, INSERT ON omni_moltbook_interest_observations TO omni_runtime;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_events TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    GRANT SELECT, INSERT ON omni_moltbook_authority_versions TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_enrollments TO omni_maintenance;
    GRANT UPDATE (
      status, next_cycle_at, last_cycle_at, last_paused_at,
      last_resumed_at, revoked_at, updated_at
    ) ON omni_moltbook_autonomy_enrollments TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_cycles TO omni_maintenance;
    GRANT UPDATE (
      status, lease_expires_at, agent_run_id, started_at, completed_at,
      outcome_sha256, summary_sha256, error_code, updated_at
    ) ON omni_moltbook_autonomy_cycles TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_action_claims TO omni_maintenance;
    GRANT UPDATE (status, tool_execution_id, consumed_at)
      ON omni_moltbook_autonomy_action_claims TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_moltbook_interest_observations TO omni_maintenance;
    GRANT SELECT, INSERT ON omni_moltbook_autonomy_events TO omni_maintenance;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
    GRANT SELECT ON omni_moltbook_authority_versions TO omni_backup;
    GRANT SELECT ON omni_moltbook_autonomy_enrollments TO omni_backup;
    GRANT SELECT ON omni_moltbook_autonomy_cycles TO omni_backup;
    GRANT SELECT ON omni_moltbook_autonomy_action_claims TO omni_backup;
    GRANT SELECT ON omni_moltbook_interest_observations TO omni_backup;
    GRANT SELECT ON omni_moltbook_autonomy_events TO omni_backup;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_class relation
    WHERE relation.oid IN (
      'omni_moltbook_authority_versions'::regclass,
      'omni_moltbook_autonomy_enrollments'::regclass,
      'omni_moltbook_autonomy_cycles'::regclass,
      'omni_moltbook_autonomy_action_claims'::regclass,
      'omni_moltbook_interest_observations'::regclass,
      'omni_moltbook_autonomy_events'::regclass
    ) AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) <> 6 OR (
    SELECT count(*)
    FROM pg_policy policy
    WHERE policy.polrelid IN (
      'omni_moltbook_authority_versions'::regclass,
      'omni_moltbook_autonomy_enrollments'::regclass,
      'omni_moltbook_autonomy_cycles'::regclass,
      'omni_moltbook_autonomy_action_claims'::regclass,
      'omni_moltbook_interest_observations'::regclass,
      'omni_moltbook_autonomy_events'::regclass
    ) AND NOT policy.polpermissive AND policy.polcmd = '*'
      AND policy.polname LIKE '%_actor'
  ) <> 6 THEN
    RAISE EXCEPTION 'Moltbook autonomy actor-private RLS is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  194,
  'moltbook_autonomy_v1',
  '66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef',
  clock_timestamp()
);

COMMIT;
