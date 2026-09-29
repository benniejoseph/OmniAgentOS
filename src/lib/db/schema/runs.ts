import "server-only";

import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for runs, threads, tool executions, delegation and
// run checkpoints.

export async function ensureActorPrivateRunThreadLedgers(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_current_actor_scope_v1()
    RETURNS JSONB
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      raw_scope TEXT;
      actor_scope JSONB;
      actor_count INTEGER;
      distinct_actor_count INTEGER;
    BEGIN
      raw_scope := NULLIF(
        current_setting('omni.actor_scope_v1', TRUE),
        ''
      );
      IF raw_scope IS NULL THEN
        RETURN NULL;
      END IF;
      actor_scope := raw_scope::JSONB;
      IF jsonb_typeof(actor_scope) <> 'object'
        OR actor_scope ->> 'version' <> '1'
        OR actor_scope ->> 'tenantId' IS DISTINCT FROM
          NULLIF(current_setting('omni.tenant_id', TRUE), '')
        OR jsonb_typeof(actor_scope -> 'actorIds') <> 'array'
      THEN
        RETURN NULL;
      END IF;
      actor_count := jsonb_array_length(actor_scope -> 'actorIds');
      IF actor_count NOT BETWEEN 1 AND 8 THEN
        RETURN NULL;
      END IF;
      SELECT count(*), count(DISTINCT actor_id COLLATE "C")
      INTO actor_count, distinct_actor_count
      FROM jsonb_array_elements(actor_scope -> 'actorIds') actor(actor_value)
      CROSS JOIN LATERAL (
        SELECT actor.actor_value #>> '{}' AS actor_id
      ) value
      WHERE jsonb_typeof(actor.actor_value) = 'string'
        AND value.actor_id = btrim(value.actor_id)
        AND char_length(value.actor_id) BETWEEN 1 AND 320;
      IF actor_count <> jsonb_array_length(actor_scope -> 'actorIds')
        OR distinct_actor_count <> actor_count
      THEN
        RETURN NULL;
      END IF;
      RETURN actor_scope;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_scope_v1_allows_validated(
      actor_scope JSONB,
      row_tenant_id TEXT,
      row_actor_id TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        actor_scope ->> 'tenantId' = row_tenant_id
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(actor_scope -> 'actorIds') actor(actor_id)
          WHERE actor.actor_id COLLATE "C" = row_actor_id COLLATE "C"
        ),
        FALSE
      )
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_scope_v1_allows(
      row_tenant_id TEXT,
      row_actor_id TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT public.omni_actor_scope_v1_allows_validated(
        public.omni_current_actor_scope_v1(),
        row_tenant_id,
        row_actor_id
      )
    $function$
  `;

  await sql`
    ALTER TABLE omni_agent_runs
    ADD COLUMN IF NOT EXISTS owner_actor_id TEXT
  `;
  await sql`
    UPDATE omni_agent_runs run
    SET owner_actor_id = COALESCE(
      (
        SELECT NULLIF(btrim(thread.actor_id), '')
        FROM omni_threads thread
        WHERE thread.tenant_id = run.tenant_id
          AND thread.id = run.thread_id
        LIMIT 1
      ),
      NULLIF(btrim(run.continuation #>> '{context,actorId}'), ''),
      (
        SELECT NULLIF(
          btrim(candidate.payload #>> '{_executionScope,initiatingActorId}'),
          ''
        )
        FROM omni_events candidate
        WHERE candidate.tenant_id = run.tenant_id
          AND candidate.stream_id = 'run:' || run.id
          AND candidate.payload ? '_executionScope'
        ORDER BY
          CASE WHEN candidate.type = 'run.scope_bound' THEN 0 ELSE 1 END,
          candidate.seq ASC
        LIMIT 1
      ),
      'quarantine:run:' || left(run.id, 300)
    )
    WHERE run.owner_actor_id IS NULL
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_bind_agent_run_owner()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      actor_scope JSONB;
    BEGIN
      IF NEW.owner_actor_id IS NOT NULL THEN
        RETURN NEW;
      END IF;
      actor_scope := omni_current_actor_scope_v1();
      IF actor_scope IS NOT NULL THEN
        NEW.owner_actor_id := actor_scope -> 'actorIds' ->>
          (jsonb_array_length(actor_scope -> 'actorIds') - 1);
      END IF;
      IF NEW.owner_actor_id IS NULL AND NEW.thread_id IS NOT NULL THEN
        SELECT thread.actor_id
        INTO NEW.owner_actor_id
        FROM omni_threads thread
        WHERE thread.tenant_id = NEW.tenant_id
          AND thread.id = NEW.thread_id
        LIMIT 1;
      END IF;
      IF NEW.owner_actor_id IS NULL THEN
        RAISE EXCEPTION 'Agent run requires an actor-bound database scope'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_agent_runs_bind_owner
    ON omni_agent_runs
  `;
  await sql`
    CREATE TRIGGER omni_agent_runs_bind_owner
    BEFORE INSERT
    ON omni_agent_runs
    FOR EACH ROW
    EXECUTE FUNCTION omni_bind_agent_run_owner()
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    ALTER COLUMN owner_actor_id SET NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_agent_runs'::regclass
          AND conname = 'omni_agent_runs_owner_actor_check'
      ) THEN
        ALTER TABLE omni_agent_runs
        ADD CONSTRAINT omni_agent_runs_owner_actor_check CHECK (
          owner_actor_id = btrim(owner_actor_id)
          AND char_length(owner_actor_id) BETWEEN 1 AND 320
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    VALIDATE CONSTRAINT omni_agent_runs_owner_actor_check
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_runs_actor_started_idx
    ON omni_agent_runs (tenant_id, owner_actor_id, started_at DESC)
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_agent_run_owner_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF ROW(OLD.tenant_id, OLD.owner_actor_id)
        IS DISTINCT FROM ROW(NEW.tenant_id, NEW.owner_actor_id)
      THEN
        RAISE EXCEPTION 'Agent run ownership is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_agent_runs_owner_immutable
    ON omni_agent_runs
  `;
  await sql`
    CREATE TRIGGER omni_agent_runs_owner_immutable
    BEFORE UPDATE OF tenant_id, owner_actor_id
    ON omni_agent_runs
    FOR EACH ROW
    EXECUTE FUNCTION omni_reject_agent_run_owner_change()
  `;

  const policies = [
    [
      "omni_agent_runs",
      "omni_agent_runs_actor_scope",
      `omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        owner_actor_id
      )`,
    ],
    [
      "omni_threads",
      "omni_threads_actor_scope",
      `omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        actor_id
      )`,
    ],
    [
      "omni_agent_events",
      "omni_agent_events_actor_scope",
      `omni_system_scope_enabled() OR EXISTS (
        SELECT 1 FROM omni_agent_runs parent_run
        WHERE parent_run.tenant_id = omni_agent_events.tenant_id
          AND parent_run.id = omni_agent_events.run_id
      )`,
    ],
    [
      "omni_thread_turns",
      "omni_thread_turns_actor_scope",
      `omni_system_scope_enabled() OR EXISTS (
        SELECT 1 FROM omni_threads parent_thread
        WHERE parent_thread.tenant_id = omni_thread_turns.tenant_id
          AND parent_thread.id = omni_thread_turns.thread_id
      )`,
    ],
    [
      "omni_events",
      "omni_run_events_actor_scope",
      `omni_system_scope_enabled()
        OR left(stream_id, 4) <> 'run:'
        OR EXISTS (
          SELECT 1 FROM omni_agent_runs parent_run
          WHERE parent_run.tenant_id = omni_events.tenant_id
            AND parent_run.id = substr(omni_events.stream_id, 5)
        )`,
    ],
    [
      "omni_run_checkpoints",
      "omni_run_checkpoints_actor_scope",
      `omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        actor_id
      )`,
    ],
    [
      "omni_run_checkpoint_state_references",
      "omni_run_checkpoint_references_actor_scope",
      `omni_system_scope_enabled() OR EXISTS (
        SELECT 1 FROM omni_run_checkpoints parent_checkpoint
        WHERE parent_checkpoint.tenant_id =
            omni_run_checkpoint_state_references.tenant_id
          AND parent_checkpoint.run_id =
            omni_run_checkpoint_state_references.run_id
          AND parent_checkpoint.checkpoint_id =
            omni_run_checkpoint_state_references.checkpoint_id
      )`,
    ],
    [
      "omni_run_checkpoint_resume_claims",
      "omni_run_checkpoint_resume_claims_actor_scope",
      `omni_system_scope_enabled() OR EXISTS (
        SELECT 1 FROM omni_run_checkpoints parent_checkpoint
        WHERE parent_checkpoint.tenant_id =
            omni_run_checkpoint_resume_claims.tenant_id
          AND parent_checkpoint.run_id =
            omni_run_checkpoint_resume_claims.run_id
          AND parent_checkpoint.checkpoint_id =
            omni_run_checkpoint_resume_claims.checkpoint_id
      )`,
    ],
    [
      "omni_run_forks",
      "omni_run_forks_actor_scope",
      `omni_system_scope_enabled() OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        initiating_actor_id
      )`,
    ],
  ] as const;
  for (const [tableName, policyName, predicate] of policies) {
    await sql.query(`DROP POLICY IF EXISTS ${policyName} ON ${tableName}`);
    await sql.query(`
      CREATE POLICY ${policyName}
      ON ${tableName}
      AS RESTRICTIVE
      FOR ALL
      USING (${predicate})
      WITH CHECK (${predicate})
    `);
  }

  await sql`
    UPDATE omni_operation_jobs job
    SET payload = jsonb_set(
      job.payload,
      '{actorId}',
      to_jsonb(run.owner_actor_id),
      TRUE
    )
    FROM omni_agent_runs run
    WHERE job.type = 'agent.resume'
      AND NOT job.payload ? 'actorId'
      AND run.tenant_id = job.tenant_id
      AND run.id = job.payload ->> 'agentRunId'
  `;
  await sql`
    UPDATE omni_operation_jobs job
    SET payload = jsonb_set(
      job.payload,
      '{request,actorId}',
      to_jsonb(run.owner_actor_id),
      TRUE
    )
    FROM omni_agent_runs run
    WHERE job.type = 'memory.consolidate'
      AND NULLIF(btrim(job.payload #>> '{request,actorId}'), '') IS NULL
      AND run.tenant_id = job.tenant_id
      AND run.id = job.payload #>> '{request,runId}'
  `;

  await sql`
    DO $migration$
    DECLARE
      protected_table TEXT;
      protected_policy TEXT;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM omni_agent_runs
        WHERE owner_actor_id IS NULL
          OR owner_actor_id IS DISTINCT FROM btrim(owner_actor_id)
          OR char_length(owner_actor_id) NOT BETWEEN 1 AND 320
      ) THEN
        RAISE EXCEPTION 'Agent run ownership backfill is incomplete'
          USING ERRCODE = '55000';
      END IF;
      FOR protected_table, protected_policy IN
        SELECT * FROM (VALUES
          ('omni_agent_runs', 'omni_agent_runs_actor_scope'),
          ('omni_threads', 'omni_threads_actor_scope'),
          ('omni_agent_events', 'omni_agent_events_actor_scope'),
          ('omni_thread_turns', 'omni_thread_turns_actor_scope'),
          ('omni_events', 'omni_run_events_actor_scope'),
          ('omni_run_checkpoints', 'omni_run_checkpoints_actor_scope'),
          (
            'omni_run_checkpoint_state_references',
            'omni_run_checkpoint_references_actor_scope'
          ),
          (
            'omni_run_checkpoint_resume_claims',
            'omni_run_checkpoint_resume_claims_actor_scope'
          ),
          ('omni_run_forks', 'omni_run_forks_actor_scope')
        ) expected(table_name, policy_name)
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_class
          WHERE oid = protected_table::regclass
            AND relrowsecurity
            AND relforcerowsecurity
        ) OR NOT EXISTS (
          SELECT 1 FROM pg_policy
          WHERE polrelid = protected_table::regclass
            AND polname = protected_policy
            AND NOT polpermissive
            AND polcmd = '*'
        ) THEN
          RAISE EXCEPTION 'Actor-private policy is missing for %', protected_table
            USING ERRCODE = '55000';
        END IF;
      END LOOP;
    END
    $migration$
  `;
}

export async function ensureActorPrivateToolExecutionLedgers(sql: SqlClient) {
  await sql`
    UPDATE omni_tool_executions execution_record
    SET tenant_id = 'default'
    WHERE tenant_id IS NULL OR btrim(tenant_id) = ''
  `;
  await sql`
    UPDATE omni_tool_executions execution_record
    SET actor_id = COALESCE(
      NULLIF(btrim(execution_record.actor_id), ''),
      (
        SELECT NULLIF(
          btrim(event.payload #>> '{_executionScope,initiatingActorId}'),
          ''
        )
        FROM omni_events event
        WHERE event.tenant_id = execution_record.tenant_id
          AND event.stream_id = 'tool_execution:' || execution_record.id
          AND event.payload ? '_executionScope'
        ORDER BY
          CASE WHEN event.type = 'tool.scope_bound' THEN 0 ELSE 1 END,
          event.seq ASC
        LIMIT 1
      ),
      NULLIF(btrim(execution_record.effect_receipt ->> 'actorId'), ''),
      (
        SELECT run.owner_actor_id
        FROM omni_agent_runs run
        WHERE run.tenant_id = execution_record.tenant_id
          AND run.continuation #>> '{pendingToolCall,executionId}' =
            execution_record.id
        ORDER BY run.started_at DESC, run.id ASC
        LIMIT 1
      ),
      'quarantine:tool:' || left(execution_record.id, 299)
    )
    WHERE execution_record.actor_id IS NULL
      OR btrim(execution_record.actor_id) = ''
  `;
  await sql`
    ALTER TABLE omni_tool_executions
    ALTER COLUMN tenant_id SET DEFAULT 'default'
  `;
  await sql`
    ALTER TABLE omni_tool_executions
    ALTER COLUMN tenant_id SET NOT NULL
  `;
  await sql`
    ALTER TABLE omni_tool_executions
    ALTER COLUMN actor_id SET NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tool_executions'::regclass
          AND conname = 'omni_tool_executions_actor_check'
      ) THEN
        ALTER TABLE omni_tool_executions
        ADD CONSTRAINT omni_tool_executions_actor_check CHECK (
          actor_id = btrim(actor_id)
          AND char_length(actor_id) BETWEEN 1 AND 320
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_tool_executions
    VALIDATE CONSTRAINT omni_tool_executions_actor_check
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_tool_executions_actor_created_idx
    ON omni_tool_executions (tenant_id, actor_id, created_at DESC)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_bind_tool_execution_actor()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      actor_scope JSONB;
    BEGIN
      IF NEW.tenant_id IS NULL OR btrim(NEW.tenant_id) = '' THEN
        NEW.tenant_id := NULLIF(
          current_setting('omni.tenant_id', TRUE),
          ''
        );
      END IF;
      IF NEW.actor_id IS NULL OR btrim(NEW.actor_id) = '' THEN
        actor_scope := public.omni_current_actor_scope_v1();
        IF actor_scope IS NOT NULL THEN
          NEW.actor_id := actor_scope -> 'actorIds' ->>
            (jsonb_array_length(actor_scope -> 'actorIds') - 1);
        END IF;
      END IF;
      IF NEW.tenant_id IS NULL OR NEW.actor_id IS NULL THEN
        RAISE EXCEPTION
          'Governed tool execution requires an actor-bound database scope'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_tool_executions_bind_actor
    ON omni_tool_executions
  `;
  await sql`
    CREATE TRIGGER omni_tool_executions_bind_actor
    BEFORE INSERT
    ON omni_tool_executions
    FOR EACH ROW
    EXECUTE FUNCTION omni_bind_tool_execution_actor()
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_tool_execution_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF ROW(
        OLD.id,
        OLD.tenant_id,
        OLD.actor_id,
        OLD.tool_id,
        OLD.tool_name,
        OLD.risk_level,
        OLD.dry_run,
        OLD.approval_required,
        OLD.input,
        OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.id,
        NEW.tenant_id,
        NEW.actor_id,
        NEW.tool_id,
        NEW.tool_name,
        NEW.risk_level,
        NEW.dry_run,
        NEW.approval_required,
        NEW.input,
        NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Governed tool execution identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_tool_executions_identity_immutable
    ON omni_tool_executions
  `;
  await sql`
    CREATE TRIGGER omni_tool_executions_identity_immutable
    BEFORE UPDATE OF
      id,
      tenant_id,
      actor_id,
      tool_id,
      tool_name,
      risk_level,
      dry_run,
      approval_required,
      input,
      created_at
    ON omni_tool_executions
    FOR EACH ROW
    EXECUTE FUNCTION omni_reject_tool_execution_identity_change()
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_scope_v1_is_active_admin(
      actor_scope JSONB,
      row_tenant_id TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        actor_scope ->> 'tenantId' = row_tenant_id
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            actor_scope -> 'actorIds'
          ) scoped_actor(actor_id)
          JOIN public.omni_auth_users auth_user
            ON auth_user.actor_id COLLATE "C" =
                scoped_actor.actor_id COLLATE "C"
              OR auth_user.email COLLATE "C" =
                scoped_actor.actor_id COLLATE "C"
          JOIN public.omni_auth_memberships membership
            ON membership.tenant_id = row_tenant_id
            AND membership.user_id = auth_user.id
          WHERE auth_user.status = 'active'
            AND membership.status = 'active'
            AND membership.role IN ('admin', 'system')
        ),
        FALSE
      )
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_tool_execution_actor_access_v1(
      actor_scope JSONB,
      row_tenant_id TEXT,
      owner_actor_id TEXT,
      row_risk_level INTEGER,
      row_status TEXT,
      row_approvals JSONB,
      row_approved_by TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        public.omni_actor_scope_v1_allows_validated(
          actor_scope,
          row_tenant_id,
          owner_actor_id
        )
        OR (
          row_risk_level >= 3
          AND public.omni_actor_scope_v1_is_active_admin(
            actor_scope,
            row_tenant_id
          )
          AND (
            row_status = 'approval_required'
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(row_approvals) = 'array'
                  THEN row_approvals
                  ELSE '[]'::JSONB
                END
              ) approval
              JOIN jsonb_array_elements_text(
                actor_scope -> 'actorIds'
              ) scoped_actor(actor_id)
                ON (approval ->> 'by') COLLATE "C" =
                  scoped_actor.actor_id COLLATE "C"
              WHERE approval ->> 'role' IN ('admin', 'system')
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                actor_scope -> 'actorIds'
              ) scoped_actor(actor_id)
              WHERE row_approved_by COLLATE "C" =
                scoped_actor.actor_id COLLATE "C"
            )
          )
        ),
        FALSE
      )
    $function$
  `;

  const toolExecutionPredicate = `
    omni_system_scope_enabled()
    OR public.omni_tool_execution_actor_access_v1(
      (SELECT public.omni_current_actor_scope_v1()),
      tenant_id,
      actor_id,
      risk_level,
      status,
      approvals,
      approved_by
    )
  `;
  await sql.query(`
    DROP POLICY IF EXISTS omni_tool_executions_actor_scope
    ON omni_tool_executions
  `);
  await sql.query(`
    CREATE POLICY omni_tool_executions_actor_scope
    ON omni_tool_executions
    AS RESTRICTIVE
    FOR ALL
    USING (${toolExecutionPredicate})
    WITH CHECK (${toolExecutionPredicate})
  `);

  const toolEventPredicate = `
    omni_system_scope_enabled()
    OR left(stream_id, 15) <> 'tool_execution:'
    OR public.omni_actor_scope_v1_allows_validated(
      (SELECT public.omni_current_actor_scope_v1()),
      tenant_id,
      actor_id
    )
    OR EXISTS (
      SELECT 1
      FROM omni_tool_executions parent_execution
      WHERE parent_execution.tenant_id = omni_events.tenant_id
        AND parent_execution.id = substr(omni_events.stream_id, 16)
    )
  `;
  await sql.query(`
    DROP POLICY IF EXISTS omni_tool_events_actor_scope
    ON omni_events
  `);
  await sql.query(`
    CREATE POLICY omni_tool_events_actor_scope
    ON omni_events
    AS RESTRICTIVE
    FOR ALL
    USING (${toolEventPredicate})
    WITH CHECK (${toolEventPredicate})
  `);

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM omni_tool_executions
        WHERE tenant_id IS NULL
          OR actor_id IS NULL
          OR actor_id IS DISTINCT FROM btrim(actor_id)
          OR char_length(actor_id) NOT BETWEEN 1 AND 320
      ) THEN
        RAISE EXCEPTION 'Governed tool execution ownership backfill is incomplete'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_tool_executions'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_tool_executions'::regclass
          AND polname = 'omni_tool_executions_actor_scope'
          AND NOT polpermissive
          AND polcmd = '*'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_events'::regclass
          AND polname = 'omni_tool_events_actor_scope'
          AND NOT polpermissive
          AND polcmd = '*'
      ) THEN
        RAISE EXCEPTION 'Actor-private governed tool policy is incomplete'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureToolExecutionRetentionRedactionV1(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_tool_execution_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      is_expired_approval_redaction BOOLEAN;
    BEGIN
      is_expired_approval_redaction := COALESCE((
        OLD.input IS DISTINCT FROM NEW.input
        AND OLD.status = 'approval_required'
        AND OLD.output IS NULL
        AND OLD.approval_decision IS NULL
        AND OLD.effect_receipt IS NULL
        AND OLD.completed_at IS NULL
        AND NEW.status = 'rejected'
        AND NEW.input = '{"redacted":"expired approval"}'::JSONB
        AND NEW.output IS NULL
        AND NEW.reason = 'Approval expired before an operator decision.'
        AND NEW.approval_decision = 'rejected'
        AND NEW.approval_reason = 'Expired by retention policy.'
        AND NEW.effect_receipt IS NULL
        AND NEW.completed_at IS NOT NULL
      ), FALSE);

      IF ROW(
        OLD.id,
        OLD.tenant_id,
        OLD.actor_id,
        OLD.tool_id,
        OLD.tool_name,
        OLD.risk_level,
        OLD.dry_run,
        OLD.approval_required,
        OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.id,
        NEW.tenant_id,
        NEW.actor_id,
        NEW.tool_id,
        NEW.tool_name,
        NEW.risk_level,
        NEW.dry_run,
        NEW.approval_required,
        NEW.created_at
      ) OR (
        OLD.input IS DISTINCT FROM NEW.input
        AND NOT is_expired_approval_redaction
      ) THEN
        RAISE EXCEPTION 'Governed tool execution identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
}

export async function ensureActorScopedEventCorrelationIndex(sql: SqlClient) {
  await sql`
    CREATE INDEX IF NOT EXISTS omni_events_actor_correlation_seq_idx
    ON omni_events (tenant_id, actor_id, correlation_id, seq ASC)
    WHERE correlation_id IS NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE index_relation.relname =
          'omni_events_actor_correlation_seq_idx'
          AND index_record.indrelid = 'omni_events'::regclass
          AND index_record.indisvalid
          AND index_record.indpred IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Actor-scoped event correlation index is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureRecurringFailureFeedbackV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_evaluation_failure_observations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      eval_run_id TEXT NOT NULL REFERENCES omni_eval_runs(id) ON DELETE CASCADE,
      source_result_id TEXT NOT NULL REFERENCES omni_eval_results(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      case_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'warn')),
      failure_category TEXT,
      failure_fingerprint TEXT,
      failure_signal_sha256 TEXT,
      case_definition_sha256 TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_evaluation_failure_observation_bounds CHECK (
        length(id) BETWEEN 1 AND 240
        AND length(tenant_id) BETWEEN 1 AND 240
        AND length(eval_run_id) BETWEEN 1 AND 240
        AND length(source_result_id) BETWEEN 1 AND 240
        AND length(case_id) BETWEEN 1 AND 120
        AND length(case_type) BETWEEN 1 AND 40
        AND case_definition_sha256 ~ '^[a-f0-9]{64}$'
        AND (
          status <> 'fail'
          OR (
            failure_category IS NOT NULL
            AND length(failure_category) BETWEEN 1 AND 80
            AND failure_fingerprint ~ '^[a-f0-9]{64}$'
            AND failure_signal_sha256 ~ '^[a-f0-9]{64}$'
          )
        )
      ),
      CONSTRAINT omni_evaluation_failure_observation_result_unique
        UNIQUE (tenant_id, source_result_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_evaluation_failure_clusters (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      case_id TEXT NOT NULL,
      case_type TEXT NOT NULL,
      failure_category TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
      failure_count INTEGER NOT NULL,
      pass_count INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL,
      consecutive_passes INTEGER NOT NULL,
      replay_case JSONB NOT NULL,
      replay_case_sha256 TEXT NOT NULL,
      latest_eval_run_id TEXT NOT NULL,
      latest_result_id TEXT NOT NULL,
      latest_proposal_version INTEGER NOT NULL DEFAULT 0,
      last_proposal_failure_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_evaluation_failure_cluster_bounds CHECK (
        length(id) BETWEEN 1 AND 240
        AND length(tenant_id) BETWEEN 1 AND 240
        AND fingerprint ~ '^[a-f0-9]{64}$'
        AND length(case_id) BETWEEN 1 AND 120
        AND length(case_type) BETWEEN 1 AND 40
        AND length(failure_category) BETWEEN 1 AND 80
        AND replay_case_sha256 ~ '^[a-f0-9]{64}$'
        AND failure_count >= 1
        AND pass_count >= 0
        AND consecutive_failures >= 0
        AND consecutive_passes >= 0
        AND latest_proposal_version >= 0
        AND last_proposal_failure_count >= 0
        AND jsonb_typeof(replay_case) = 'object'
        AND (replay_case ->> 'schemaVersion')::INTEGER = 1
      ),
      CONSTRAINT omni_evaluation_failure_cluster_fingerprint_unique
        UNIQUE (tenant_id, fingerprint),
      CONSTRAINT omni_evaluation_failure_cluster_tenant_id_unique
        UNIQUE (tenant_id, id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_harness_rule_proposals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'evaluation_case', 'tool_contract', 'prompt_change',
        'workflow_guard', 'architecture_constraint', 'runbook'
      )),
      target TEXT NOT NULL,
      proposal JSONB NOT NULL,
      proposal_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      proposed_by TEXT NOT NULL,
      reviewed_by TEXT,
      review_reason TEXT,
      proposed_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_harness_rule_proposal_bounds CHECK (
        length(id) BETWEEN 1 AND 240
        AND length(tenant_id) BETWEEN 1 AND 240
        AND length(cluster_id) BETWEEN 1 AND 240
        AND version BETWEEN 1 AND 1000000
        AND length(target) BETWEEN 1 AND 240
        AND proposal_sha256 ~ '^[a-f0-9]{64}$'
        AND length(proposed_by) BETWEEN 1 AND 240
        AND (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 240)
        AND (review_reason IS NULL OR length(review_reason) BETWEEN 12 AND 500)
        AND jsonb_typeof(proposal) = 'object'
        AND (proposal ->> 'schemaVersion')::INTEGER = 1
        AND (proposal ->> 'reviewRequired')::BOOLEAN
        AND NOT (proposal ->> 'automaticApplication')::BOOLEAN
        AND (
          (status = 'proposed' AND reviewed_by IS NULL AND reviewed_at IS NULL)
          OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL
            AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL)
        )
      ),
      CONSTRAINT omni_harness_rule_proposal_cluster_fk
        FOREIGN KEY (tenant_id, cluster_id)
        REFERENCES omni_evaluation_failure_clusters(tenant_id, id),
      CONSTRAINT omni_harness_rule_proposal_version_unique
        UNIQUE (tenant_id, cluster_id, version)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_evaluation_failure_observations_case_idx
    ON omni_evaluation_failure_observations (tenant_id, case_id, observed_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_evaluation_failure_clusters_status_idx
    ON omni_evaluation_failure_clusters (
      tenant_id, status, consecutive_failures DESC, updated_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_harness_rule_proposals_status_idx
    ON omni_harness_rule_proposals (tenant_id, status, updated_at DESC)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_harness_rule_proposals_open_idx
    ON omni_harness_rule_proposals (tenant_id, cluster_id)
    WHERE status = 'proposed'
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_guard_harness_rule_proposal_update()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF ROW(
        OLD.id, OLD.tenant_id, OLD.cluster_id, OLD.version, OLD.kind,
        OLD.target, OLD.proposal, OLD.proposal_sha256, OLD.proposed_by,
        OLD.proposed_at, OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.id, NEW.tenant_id, NEW.cluster_id, NEW.version, NEW.kind,
        NEW.target, NEW.proposal, NEW.proposal_sha256, NEW.proposed_by,
        NEW.proposed_at, NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Harness rule proposal identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Harness rule proposal review transition is invalid'
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
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_harness_rule_proposals'::regclass
          AND tgname = 'omni_harness_rule_proposals_guard'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_harness_rule_proposals_guard
        BEFORE UPDATE ON omni_harness_rule_proposals
        FOR EACH ROW EXECUTE FUNCTION omni_guard_harness_rule_proposal_update();
      END IF;
    END
    $migration$
  `;
  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    DECLARE
      table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'omni_evaluation_failure_observations',
        'omni_evaluation_failure_clusters',
        'omni_harness_rule_proposals'
      ] LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_class
          WHERE oid = table_name::regclass
            AND relrowsecurity AND relforcerowsecurity
        ) OR NOT EXISTS (
          SELECT 1 FROM pg_policy
          WHERE polrelid = table_name::regclass
            AND polname = 'omni_tenant_isolation'
        ) THEN
          RAISE EXCEPTION 'Recurring failure feedback tenant boundary is invalid'
            USING ERRCODE = '55000';
        END IF;
      END LOOP;
    END
    $migration$
  `;
}

export async function ensureLoopV2InterruptionRecoveryV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'omni_agent_runs'::regclass
          AND conname = 'omni_agent_runs_loop_v2_recovery_check'
      ) THEN
        ALTER TABLE omni_agent_runs
        ADD CONSTRAINT omni_agent_runs_loop_v2_recovery_check
        CHECK (
          NOT (COALESCE(continuation, '{}'::jsonb) ? 'loopV2Recovery')
          OR COALESCE(
            status = 'resuming'
            AND jsonb_typeof(continuation -> 'loopV2Recovery') = 'object'
            AND continuation -> 'loopV2Recovery' ?& ARRAY[
              'schemaVersion', 'checkpointSha256', 'leaseGeneration',
              'claimTokenSha256', 'leaseOwnerSha256', 'claimedAt',
              'leaseExpiresAt'
            ]
            AND continuation #>> '{loopV2Recovery,schemaVersion}' = '1'
            AND continuation #>> '{loopV2Recovery,checkpointSha256}'
              ~ '^[a-f0-9]{64}$'
            AND continuation #>> '{loopV2Recovery,leaseGeneration}'
              ~ '^[1-9][0-9]{0,15}$'
            AND continuation #>> '{loopV2Recovery,claimTokenSha256}'
              ~ '^[a-f0-9]{64}$'
            AND continuation #>> '{loopV2Recovery,leaseOwnerSha256}'
              ~ '^[a-f0-9]{64}$'
            AND NOT (continuation -> 'loopV2Recovery' ? 'claimToken')
            AND (continuation #>> '{loopV2Recovery,claimedAt}')::timestamptz
              <= (continuation #>> '{loopV2Recovery,leaseExpiresAt}')::timestamptz,
            FALSE
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    VALIDATE CONSTRAINT omni_agent_runs_loop_v2_recovery_check
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_loop_v2_recovery_candidates_idx
    ON omni_agent_loop_v2_checkpoints (
      tenant_id, transitioned_at ASC, run_id, sequence DESC
    )
    WHERE lifecycle_state = 'active'
  `;
  await sql`
    DO $migration$
    DECLARE
      recovery_constraint TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid)
      INTO recovery_constraint
      FROM pg_constraint
      WHERE conrelid = 'omni_agent_runs'::regclass
        AND conname = 'omni_agent_runs_loop_v2_recovery_check'
        AND contype = 'c'
        AND convalidated;

      IF recovery_constraint IS NULL
        OR recovery_constraint NOT LIKE '%loopV2Recovery%'
        OR recovery_constraint NOT LIKE '%claimTokenSha256%'
        OR recovery_constraint NOT LIKE '%leaseExpiresAt%'
        OR recovery_constraint NOT LIKE '%NOT%claimToken%'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_index index_record
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          WHERE index_relation.relname =
              'omni_agent_loop_v2_recovery_candidates_idx'
            AND index_record.indrelid =
              'omni_agent_loop_v2_checkpoints'::regclass
            AND index_record.indisvalid
            AND index_record.indpred IS NOT NULL
        )
      THEN
        RAISE EXCEPTION 'Loop v2 interruption recovery invariant is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureAgentRunTerminalReceiptsV1(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_agent_runs
    ADD COLUMN IF NOT EXISTS terminal_receipt JSONB
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'omni_agent_runs'::regclass
          AND conname = 'omni_agent_runs_terminal_receipt_check'
      ) THEN
        ALTER TABLE omni_agent_runs
        ADD CONSTRAINT omni_agent_runs_terminal_receipt_check
        CHECK (
          terminal_receipt IS NULL
          OR COALESCE(
            jsonb_typeof(terminal_receipt) = 'object'
            AND terminal_receipt ->> 'schemaVersion' = '1'
            AND terminal_receipt ->> 'runId' = id
            AND terminal_receipt ->> 'source' = 'outcome_evaluator'
            AND terminal_receipt ->> 'outcomeContractId' IS NOT NULL
            AND terminal_receipt ->> 'terminalReceiptId' IS NOT NULL
            AND (
              status = 'completed'
              AND terminal_receipt ->> 'disposition' IN (
                'succeeded', 'partial', 'unverified'
              )
              OR status = 'failed'
              AND terminal_receipt ->> 'disposition' = 'failed'
              OR status = 'canceled'
              AND terminal_receipt ->> 'disposition' = 'canceled'
            ),
            FALSE
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    VALIDATE CONSTRAINT omni_agent_runs_terminal_receipt_check
  `;
  await sql`
    DO $migration$
    DECLARE
      receipt_constraint TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid)
      INTO receipt_constraint
      FROM pg_constraint
      WHERE conrelid = 'omni_agent_runs'::regclass
        AND conname = 'omni_agent_runs_terminal_receipt_check'
        AND contype = 'c'
        AND convalidated;

      IF receipt_constraint IS NULL
        OR receipt_constraint NOT LIKE '%outcome_evaluator%'
        OR receipt_constraint NOT LIKE '%outcomeContractId%'
        OR receipt_constraint NOT LIKE '%terminalReceiptId%'
        OR receipt_constraint NOT LIKE '%runId%'
      THEN
        RAISE EXCEPTION 'Agent-run terminal receipt invariant is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureConversationSummaryHierarchyV1(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_threads
    ADD COLUMN IF NOT EXISTS project_id TEXT
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_threads'::regclass
          AND conname = 'omni_threads_project_fk'
      ) THEN
        ALTER TABLE omni_threads
        ADD CONSTRAINT omni_threads_project_fk
        FOREIGN KEY (project_id) REFERENCES omni_projects(id)
        ON DELETE SET NULL NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_threads
    VALIDATE CONSTRAINT omni_threads_project_fk
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_threads_project_updated_idx
    ON omni_threads (tenant_id, actor_id, project_id, updated_at DESC)
    WHERE project_id IS NOT NULL
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_thread_project_scope()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND ROW(OLD.tenant_id, OLD.actor_id, OLD.project_id)
          IS DISTINCT FROM ROW(NEW.tenant_id, NEW.actor_id, NEW.project_id)
      THEN
        RAISE EXCEPTION 'Thread ownership and project scope are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.omni_projects project
        WHERE project.id = NEW.project_id
          AND project.tenant_id = NEW.tenant_id
          AND project.actor_id = NEW.actor_id
      ) THEN
        RAISE EXCEPTION 'Thread project scope is invalid'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_thread_project_scope()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_threads_project_scope
    ON omni_threads
  `;
  await sql`
    CREATE TRIGGER omni_threads_project_scope
    BEFORE INSERT OR UPDATE OF tenant_id, actor_id, project_id
    ON omni_threads
    FOR EACH ROW
    EXECUTE FUNCTION omni_validate_thread_project_scope()
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_conversation_summaries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      level TEXT NOT NULL,
      bucket_index INTEGER NOT NULL,
      thread_id TEXT REFERENCES omni_threads(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES omni_projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      source_turn_ids TEXT[] NOT NULL,
      child_summary_ids TEXT[] NOT NULL,
      source_sha256 TEXT NOT NULL,
      summary_sha256 TEXT NOT NULL,
      access_scope JSONB NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      rebuildable BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_conversation_summary_shape_check CHECK (
        level IN ('turn', 'episode', 'project', 'lifetime_index')
        AND bucket_index >= 0
        AND char_length(content) BETWEEN 1 AND 12000
        AND cardinality(source_turn_ids) BETWEEN 1 AND 4096
        AND cardinality(child_summary_ids) BETWEEN 0 AND 1024
        AND source_sha256 ~ '^[0-9a-f]{64}$'
        AND summary_sha256 ~ '^[0-9a-f]{64}$'
        AND rebuildable
        AND starts_at <= ends_at
        AND (
          (level IN ('turn', 'episode') AND thread_id IS NOT NULL)
          OR (level IN ('project', 'lifetime_index') AND thread_id IS NULL)
        )
        AND (level <> 'project' OR project_id IS NOT NULL)
        AND (level <> 'lifetime_index' OR project_id IS NULL)
        AND (level <> 'turn' OR cardinality(source_turn_ids) = 1)
        AND (level = 'turn' OR cardinality(child_summary_ids) > 0)
        AND jsonb_typeof(access_scope) = 'object'
        AND access_scope ->> 'schemaVersion' = '1'
        AND access_scope ->> 'visibility' = 'user_private'
        AND access_scope ->> 'tenantId' = tenant_id
        AND access_scope ->> 'actorId' = owner_actor_id
        AND access_scope -> 'purposeIds'
          = '["conversation.context.compile.v1"]'::jsonb
        AND access_scope ->> 'scopeSha256' ~ '^[0-9a-f]{64}$'
        AND access_scope ->> 'threadId' IS NOT DISTINCT FROM thread_id
        AND access_scope ->> 'projectId' IS NOT DISTINCT FROM project_id
      )
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_conversation_summary_bucket_idx
    ON omni_conversation_summaries (
      tenant_id, owner_actor_id, level,
      COALESCE(thread_id, ''), COALESCE(project_id, ''), bucket_index
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_conversation_summary_thread_time_idx
    ON omni_conversation_summaries (
      tenant_id, owner_actor_id, thread_id, starts_at ASC, id
    )
    WHERE thread_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_conversation_summary_project_time_idx
    ON omni_conversation_summaries (
      tenant_id, owner_actor_id, project_id, starts_at ASC, id
    )
    WHERE project_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_conversation_summary_lifetime_time_idx
    ON omni_conversation_summaries (
      tenant_id, owner_actor_id, starts_at ASC, id
    )
    WHERE level = 'lifetime_index'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_conversation_summary_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      matched_turns INTEGER;
      matched_children INTEGER;
    BEGIN
      IF TG_OP = 'UPDATE'
        AND ROW(
          OLD.tenant_id, OLD.owner_actor_id, OLD.level,
          OLD.bucket_index, OLD.thread_id, OLD.project_id, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id, NEW.owner_actor_id, NEW.level,
          NEW.bucket_index, NEW.thread_id, NEW.project_id, NEW.created_at
        )
      THEN
        RAISE EXCEPTION 'Conversation summary identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF cardinality(NEW.source_turn_ids) <> (
        SELECT COUNT(DISTINCT source_id)
        FROM unnest(NEW.source_turn_ids) source_id
      ) OR cardinality(NEW.child_summary_ids) <> (
        SELECT COUNT(DISTINCT child_id)
        FROM unnest(NEW.child_summary_ids) child_id
      ) THEN
        RAISE EXCEPTION 'Conversation summary lineage contains duplicates'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.thread_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.omni_threads thread
        WHERE thread.id = NEW.thread_id
          AND thread.tenant_id = NEW.tenant_id
          AND thread.actor_id = NEW.owner_actor_id
          AND thread.project_id IS NOT DISTINCT FROM NEW.project_id
      ) THEN
        RAISE EXCEPTION 'Conversation summary thread scope is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.omni_projects project
        WHERE project.id = NEW.project_id
          AND project.tenant_id = NEW.tenant_id
          AND project.actor_id = NEW.owner_actor_id
      ) THEN
        RAISE EXCEPTION 'Conversation summary project scope is invalid'
          USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(DISTINCT turn.id) INTO matched_turns
      FROM unnest(NEW.source_turn_ids) source_id
      JOIN public.omni_thread_turns turn ON turn.id = source_id
      JOIN public.omni_threads thread ON thread.id = turn.thread_id
      WHERE turn.tenant_id = NEW.tenant_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.actor_id = NEW.owner_actor_id
        AND (
          NEW.thread_id IS NULL
          OR turn.thread_id = NEW.thread_id
        )
        AND (
          NEW.project_id IS NULL
          OR thread.project_id = NEW.project_id
        );
      IF matched_turns <> cardinality(NEW.source_turn_ids) THEN
        RAISE EXCEPTION 'Conversation summary source-turn lineage is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.level = 'turn' THEN
        IF cardinality(NEW.child_summary_ids) <> 0 THEN
          RAISE EXCEPTION 'Turn summary child lineage is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      SELECT COUNT(DISTINCT child.id) INTO matched_children
      FROM unnest(NEW.child_summary_ids) child_id
      JOIN public.omni_conversation_summaries child ON child.id = child_id
      WHERE child.tenant_id = NEW.tenant_id
        AND child.owner_actor_id = NEW.owner_actor_id
        AND (
          (NEW.level = 'episode'
            AND child.level = 'turn'
            AND child.thread_id = NEW.thread_id
            AND child.project_id IS NOT DISTINCT FROM NEW.project_id)
          OR (NEW.level = 'project'
            AND child.level = 'episode'
            AND child.project_id = NEW.project_id)
          OR (NEW.level = 'lifetime_index' AND child.level = 'episode')
        );
      IF matched_children <> cardinality(NEW.child_summary_ids) THEN
        RAISE EXCEPTION 'Conversation summary child lineage is invalid'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_validate_conversation_summary_lineage()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_conversation_summary_lineage
    ON omni_conversation_summaries
  `;
  await sql`
    CREATE TRIGGER omni_conversation_summary_lineage
    BEFORE INSERT OR UPDATE
    ON omni_conversation_summaries
    FOR EACH ROW
    EXECUTE FUNCTION omni_validate_conversation_summary_lineage()
  `;

  await ensureTenantIsolationPolicies(sql);
  await sql`
    ALTER TABLE omni_conversation_summaries
    ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_conversation_summaries
    FORCE ROW LEVEL SECURITY
  `;
  await sql`
    DROP POLICY IF EXISTS omni_conversation_summaries_actor_scope
    ON omni_conversation_summaries
  `;
  await sql`
    CREATE POLICY omni_conversation_summaries_actor_scope
    ON omni_conversation_summaries
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        owner_actor_id
      )
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR public.omni_actor_scope_v1_allows_validated(
        (SELECT public.omni_current_actor_scope_v1()),
        tenant_id,
        owner_actor_id
      )
    )
  `;
  await sql`REVOKE ALL ON TABLE omni_conversation_summaries FROM PUBLIC`;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_conversation_summaries'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_conversation_summaries'::regclass
          AND polname = 'omni_conversation_summaries_actor_scope'
          AND NOT polpermissive
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_conversation_summaries'::regclass
          AND tgname = 'omni_conversation_summary_lineage'
          AND NOT tgisinternal
      ) THEN
        RAISE EXCEPTION 'Conversation summary hierarchy boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureConversationSummaryDeletionBarrierV1(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_delete_turn_derived_conversation_summaries()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      DELETE FROM public.omni_conversation_summaries summary
      WHERE summary.tenant_id = OLD.tenant_id
        AND OLD.id = ANY(summary.source_turn_ids);
      RETURN OLD;
    END
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_delete_turn_derived_conversation_summaries()
    FROM PUBLIC
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_thread_turns_delete_summaries
    ON omni_thread_turns
  `;
  await sql`
    CREATE TRIGGER omni_thread_turns_delete_summaries
    BEFORE DELETE ON omni_thread_turns
    FOR EACH ROW
    EXECUTE FUNCTION omni_delete_turn_derived_conversation_summaries()
  `;

  await sql`
    DELETE FROM omni_conversation_summaries summary
    WHERE EXISTS (
      SELECT 1
      FROM unnest(summary.source_turn_ids) source_id
      WHERE NOT EXISTS (
        SELECT 1 FROM omni_thread_turns turn
        JOIN omni_threads thread ON thread.id = turn.thread_id
        WHERE turn.id = source_id
          AND turn.tenant_id = summary.tenant_id
          AND thread.tenant_id = summary.tenant_id
          AND thread.actor_id = summary.owner_actor_id
      )
    )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_conversation_summaries summary
        WHERE EXISTS (
          SELECT 1
          FROM unnest(summary.source_turn_ids) source_id
          WHERE NOT EXISTS (
            SELECT 1 FROM omni_thread_turns turn
            JOIN omni_threads thread ON thread.id = turn.thread_id
            WHERE turn.id = source_id
              AND turn.tenant_id = summary.tenant_id
              AND thread.tenant_id = summary.tenant_id
              AND thread.actor_id = summary.owner_actor_id
          )
        )
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_thread_turns'::regclass
          AND tgname = 'omni_thread_turns_delete_summaries'
          AND NOT tgisinternal
      ) THEN
        RAISE EXCEPTION 'Conversation summary deletion barrier is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureDelegationTaskLifecycleV1(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 115
          AND name = 'agent_adaptation_lifecycle_v1'
          AND checksum =
            'adb861cb8c067108beaa6e0f92eb206086541f766e5665421fe887e2a11d90e5'
      ) <> 1 THEN
        RAISE EXCEPTION 'Delegation task lifecycle predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_delegation_tasks (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      parent_execution_id TEXT NOT NULL,
      parent_principal_id TEXT NOT NULL,
      parent_delegation_id TEXT,
      delegation_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      contract_sha256 TEXT NOT NULL,
      delegate_principal_id TEXT NOT NULL,
      delegate_agent_id TEXT NOT NULL,
      delegate_definition_version BIGINT NOT NULL,
      verifier_agent_id TEXT NOT NULL,
      verifier_definition_version BIGINT NOT NULL,
      verifier_acceptance_threshold DOUBLE PRECISION NOT NULL,
      state TEXT NOT NULL DEFAULT 'proposed',
      lifecycle_revision SMALLINT NOT NULL DEFAULT 0,
      task JSONB NOT NULL,
      task_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      accept_by TIMESTAMPTZ NOT NULL,
      complete_by TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      terminal_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, task_id),
      UNIQUE (tenant_id, delegation_id),
      CHECK (schema_version = 1),
      CHECK (char_length(task_id) BETWEEN 1 AND 240),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(parent_execution_id) BETWEEN 1 AND 240),
      CHECK (char_length(parent_principal_id) BETWEEN 1 AND 240),
      CHECK (parent_delegation_id IS NULL OR char_length(parent_delegation_id) BETWEEN 1 AND 240),
      CHECK (char_length(delegation_id) BETWEEN 1 AND 240),
      CHECK (char_length(contract_id) BETWEEN 1 AND 240),
      CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (char_length(delegate_principal_id) BETWEEN 1 AND 240),
      CHECK (char_length(delegate_agent_id) BETWEEN 1 AND 240),
      CHECK (delegate_definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (char_length(verifier_agent_id) BETWEEN 1 AND 240),
      CHECK (verifier_definition_version BETWEEN 1 AND 9007199254740991),
      CHECK (verifier_acceptance_threshold BETWEEN 0.5 AND 1),
      CHECK (state IN (
        'proposed', 'accepted', 'working', 'waiting', 'challenged',
        'completed_proposed', 'result_accepted', 'rejected', 'canceled',
        'expired'
      )),
      CHECK (lifecycle_revision BETWEEN 0 AND 32),
      CHECK (jsonb_typeof(task) = 'object'),
      CHECK (task ?& ARRAY[
        'schemaVersion', 'version', 'taskId', 'taskSha256', 'tenantId',
        'ownerActorId', 'parentExecutionId', 'parentPrincipalId',
        'parentDelegationId', 'delegationId', 'contractId',
        'contractSha256', 'delegatePrincipalId', 'delegateAgentId',
        'delegateDefinitionVersion', 'verifierAgentId',
        'verifierDefinitionVersion', 'verifierAcceptanceThreshold', 'state',
        'lifecycleRevision', 'proposal', 'evaluation', 'createdAt', 'acceptBy',
        'completeBy', 'updatedAt', 'terminalAt'
      ]),
      CHECK (task_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (created_at <= updated_at),
      CHECK (created_at <= accept_by AND accept_by < complete_by),
      CHECK ((state IN ('result_accepted', 'rejected', 'canceled', 'expired')) = (terminal_at IS NOT NULL)),
      CHECK (task->>'version' = 'p8.3-delegation-task:1'),
      CHECK (task->>'schemaVersion' = '1'),
      CHECK (task->>'taskId' = task_id),
      CHECK (task->>'taskSha256' = task_sha256),
      CHECK (task->>'tenantId' = tenant_id),
      CHECK (task->>'ownerActorId' = owner_actor_id),
      CHECK (task->>'parentExecutionId' = parent_execution_id),
      CHECK (task->>'parentPrincipalId' = parent_principal_id),
      CHECK ((task->>'parentDelegationId') IS NOT DISTINCT FROM parent_delegation_id),
      CHECK (task->>'delegationId' = delegation_id),
      CHECK (task->>'contractId' = contract_id),
      CHECK (task->>'contractSha256' = contract_sha256),
      CHECK (task->>'delegatePrincipalId' = delegate_principal_id),
      CHECK (task->>'delegateAgentId' = delegate_agent_id),
      CHECK ((task->>'delegateDefinitionVersion')::BIGINT = delegate_definition_version),
      CHECK (task->>'verifierAgentId' = verifier_agent_id),
      CHECK ((task->>'verifierDefinitionVersion')::BIGINT = verifier_definition_version),
      CHECK ((task->>'verifierAcceptanceThreshold')::DOUBLE PRECISION = verifier_acceptance_threshold),
      CHECK (task->>'state' = state),
      CHECK ((task->>'lifecycleRevision')::SMALLINT = lifecycle_revision),
      CHECK ((task->>'createdAt')::TIMESTAMPTZ = created_at),
      CHECK ((task->>'acceptBy')::TIMESTAMPTZ = accept_by),
      CHECK ((task->>'completeBy')::TIMESTAMPTZ = complete_by),
      CHECK ((task->>'updatedAt')::TIMESTAMPTZ = updated_at),
      CHECK (
        CASE WHEN terminal_at IS NULL
          THEN task->'terminalAt' = 'null'::jsonb
          ELSE (task->>'terminalAt')::TIMESTAMPTZ = terminal_at
        END
      ),
      CHECK (
        (state IN ('completed_proposed', 'result_accepted', 'rejected')) =
        (task->'proposal' <> 'null'::jsonb)
      ),
      CHECK (
        (state IN ('result_accepted', 'rejected')) =
        (task->'evaluation' <> 'null'::jsonb)
      ),
      CHECK (
        state <> 'result_accepted'
        OR task->'evaluation'->>'verdict' = 'accepted'
      ),
      CHECK (
        state <> 'rejected'
        OR task->'evaluation'->>'verdict' = 'rejected'
      ),
      CHECK (
        state NOT IN ('result_accepted', 'rejected')
        OR (
          task->'evaluation'->>'evaluatorPrincipalId' = parent_principal_id
          AND task->'evaluation'->>'evaluatorAgentId' = verifier_agent_id
          AND (task->'evaluation'->>'evaluatorDefinitionVersion')::BIGINT =
            verifier_definition_version
          AND task->'evaluation'->>'proposalReceiptSha256' =
            task->'proposal'->>'proposalReceiptSha256'
          AND task->'evaluation'->>'evaluationSha256' ~ '^[a-f0-9]{64}$'
          AND (task->'evaluation'->>'score')::DOUBLE PRECISION BETWEEN 0 AND 1
        )
      ),
      CHECK (
        state <> 'result_accepted'
        OR (task->'evaluation'->>'score')::DOUBLE PRECISION >=
          verifier_acceptance_threshold
      ),
      FOREIGN KEY (owner_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_delegation_tasks_parent_idx
    ON omni_delegation_tasks (
      tenant_id, owner_actor_id, parent_execution_id, created_at, task_id
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_delegation_tasks_active_idx
    ON omni_delegation_tasks (tenant_id, state, complete_by)
    WHERE state NOT IN ('result_accepted', 'rejected', 'canceled', 'expired')
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_delegation_task_v1()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Delegation tasks cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'proposed'
          OR NEW.lifecycle_revision <> 0
          OR NEW.updated_at IS DISTINCT FROM NEW.created_at
          OR NEW.terminal_at IS NOT NULL
          OR NEW.task->'proposal' <> 'null'::jsonb
          OR NEW.task->'evaluation' <> 'null'::jsonb
        THEN
          RAISE EXCEPTION 'Initial delegation task is invalid'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.task_id, NEW.owner_actor_id,
        NEW.parent_execution_id, NEW.parent_principal_id,
        NEW.parent_delegation_id, NEW.delegation_id, NEW.contract_id,
        NEW.contract_sha256, NEW.delegate_principal_id,
        NEW.delegate_agent_id, NEW.delegate_definition_version,
        NEW.verifier_agent_id, NEW.verifier_definition_version,
        NEW.verifier_acceptance_threshold,
        NEW.created_at, NEW.accept_by, NEW.complete_by
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.task_id, OLD.owner_actor_id,
        OLD.parent_execution_id, OLD.parent_principal_id,
        OLD.parent_delegation_id, OLD.delegation_id, OLD.contract_id,
        OLD.contract_sha256, OLD.delegate_principal_id,
        OLD.delegate_agent_id, OLD.delegate_definition_version,
        OLD.verifier_agent_id, OLD.verifier_definition_version,
        OLD.verifier_acceptance_threshold,
        OLD.created_at, OLD.accept_by, OLD.complete_by
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
        OR NEW.updated_at < OLD.updated_at
      THEN
        RAISE EXCEPTION 'Delegation task identity or revision is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NOT (
        (OLD.state = 'proposed' AND NEW.state IN ('accepted', 'rejected', 'canceled', 'expired'))
        OR (OLD.state = 'accepted' AND NEW.state IN ('working', 'rejected', 'canceled', 'expired'))
        OR (OLD.state = 'working' AND NEW.state IN ('waiting', 'challenged', 'completed_proposed', 'rejected', 'canceled', 'expired'))
        OR (OLD.state = 'waiting' AND NEW.state IN ('working', 'challenged', 'rejected', 'canceled', 'expired'))
        OR (OLD.state = 'challenged' AND NEW.state IN ('working', 'completed_proposed', 'rejected', 'canceled', 'expired'))
        OR (OLD.state = 'completed_proposed' AND NEW.state IN ('result_accepted', 'rejected', 'challenged', 'canceled', 'expired'))
      ) THEN
        RAISE EXCEPTION 'Delegation task transition is invalid'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.state = 'accepted' AND NEW.updated_at >= NEW.accept_by THEN
        RAISE EXCEPTION 'Delegation acceptance deadline has expired'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.state = 'expired' AND NEW.updated_at < NEW.complete_by THEN
        RAISE EXCEPTION 'Delegation cannot expire before its deadline'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.state <> 'expired' AND NEW.updated_at >= NEW.complete_by THEN
        RAISE EXCEPTION 'Delegation completion deadline has expired'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      DROP TRIGGER IF EXISTS omni_delegation_task_protect
        ON omni_delegation_tasks;
      CREATE TRIGGER omni_delegation_task_protect
      BEFORE INSERT OR UPDATE OR DELETE ON omni_delegation_tasks
      FOR EACH ROW EXECUTE FUNCTION omni_protect_delegation_task_v1();
      DROP TRIGGER IF EXISTS omni_delegation_task_no_truncate
        ON omni_delegation_tasks;
      CREATE TRIGGER omni_delegation_task_no_truncate
      BEFORE TRUNCATE ON omni_delegation_tasks
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_delegation_task_v1();
      ALTER TABLE omni_delegation_tasks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_delegation_tasks FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS omni_delegation_tasks_actor
        ON omni_delegation_tasks;
      CREATE POLICY omni_delegation_tasks_actor
      ON omni_delegation_tasks AS RESTRICTIVE FOR ALL
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_delegation_tasks FROM PUBLIC`;
  await sql`REVOKE ALL ON FUNCTION omni_protect_delegation_task_v1() FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_delegation_tasks FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_delegation_tasks TO omni_runtime;
        GRANT UPDATE (
          state, lifecycle_revision, task, task_sha256, updated_at, terminal_at
        ) ON omni_delegation_tasks TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_delegation_tasks FROM omni_maintenance';
        GRANT SELECT, INSERT ON omni_delegation_tasks TO omni_maintenance;
        GRANT UPDATE (
          state, lifecycle_revision, task, task_sha256, updated_at, terminal_at
        ) ON omni_delegation_tasks TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_delegation_tasks'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_delegation_tasks'::regclass
          AND tgname = 'omni_delegation_task_protect'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_delegation_tasks'::regclass
          AND tgname = 'omni_delegation_task_no_truncate'
          AND NOT tgisinternal AND tgenabled = 'O'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = 'omni_protect_delegation_task_v1()'::regprocedure
          AND NOT prosecdef
      ) OR EXISTS (
        SELECT 1
        FROM pg_proc function_row
        CROSS JOIN LATERAL aclexplode(COALESCE(
          function_row.proacl,
          acldefault('f', function_row.proowner)
        )) function_acl
        WHERE function_row.oid =
          'omni_protect_delegation_task_v1()'::regprocedure
          AND function_acl.grantee = 0
          AND function_acl.privilege_type = 'EXECUTE'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_delegation_tasks'::regclass
          AND polname = 'omni_delegation_tasks_actor'
          AND NOT polpermissive AND polcmd = '*'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_delegation_tasks'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) OR EXISTS (
        SELECT 1 FROM information_schema.role_column_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_delegation_tasks'
          AND grantee IN ('omni_runtime', 'omni_maintenance')
          AND privilege_type = 'UPDATE'
          AND column_name NOT IN (
            'state', 'lifecycle_revision', 'task', 'task_sha256',
            'updated_at', 'terminal_at'
          )
      ) THEN
        RAISE EXCEPTION 'Delegation task lifecycle boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureLoopV2ClarificationWait(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_agent_runs
    DROP CONSTRAINT IF EXISTS omni_agent_runs_waiting_clarification_thread_check
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    ADD CONSTRAINT omni_agent_runs_waiting_clarification_thread_check
    CHECK (
      status <> 'waiting_clarification'
      OR thread_id IS NOT NULL
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_agent_runs
    VALIDATE CONSTRAINT omni_agent_runs_waiting_clarification_thread_check
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_agent_runs_one_waiting_clarification_per_thread_idx
    ON omni_agent_runs (tenant_id, owner_actor_id, thread_id)
    WHERE status = 'waiting_clarification' AND thread_id IS NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_agent_runs_waiting_clarification_thread_check'
          AND conrelid = 'omni_agent_runs'::regclass
          AND contype = 'c'
          AND convalidated
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE index_relation.relname =
          'omni_agent_runs_one_waiting_clarification_per_thread_idx'
          AND index_record.indrelid = 'omni_agent_runs'::regclass
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indpred IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Loop v2 clarification wait invariant is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureLoopV2ModelTextEngine(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_agent_loop_v2_checkpoints
    DROP CONSTRAINT IF EXISTS
      omni_agent_loop_v2_checkpoints_engine_version_id_check
  `;
  await sql`
    ALTER TABLE omni_agent_loop_v2_checkpoints
    DROP CONSTRAINT IF EXISTS
      omni_agent_loop_v2_checkpoints_configuration_sha256_check
  `;
  await sql`
    ALTER TABLE omni_agent_loop_v2_checkpoints
    DROP CONSTRAINT IF EXISTS
      omni_agent_loop_v2_checkpoints_engine_configuration_check
  `;
  await sql`
    ALTER TABLE omni_agent_loop_v2_checkpoints
    ADD CONSTRAINT
      omni_agent_loop_v2_checkpoints_engine_configuration_check
    CHECK (
      checkpoint_json #>> '{enginePin,engineVersionId}' = engine_version_id
      AND checkpoint_json #>> '{enginePin,contractVersionId}' =
        contract_version_id
      AND checkpoint_json #>> '{enginePin,configurationSha256}' =
        configuration_sha256
      AND checkpoint_json #>> '{enginePin,rolloutMode}' = 'canary'
      AND (checkpoint_json #>> '{enginePin,rolloutGeneration}')::BIGINT =
        rollout_generation
      AND (
        checkpoint_json #>> '{enginePin,rolloutLifecycleRevision}'
      )::BIGINT = rollout_lifecycle_revision
      AND (
        (
          checkpoint_json #>> '{enginePin,capabilityId}' = 'agent_loop_v2'
          AND engine_version_id = 'agent_loop_v2_read_only_canary_1'
          AND configuration_sha256 =
            'e0d1898a2de59ca2e4ec6fa6d5b5442347bae76e43700a29cfadbfa88a4e308b'
        )
        OR (
          checkpoint_json #>> '{enginePin,capabilityId}' =
            'agent_loop_v2_model_text'
          AND engine_version_id = 'agent_loop_v2_model_text_canary_1'
          AND configuration_sha256 =
            'b9106374788a0e7f74dc00f79269848f7de0d57f210364a68151c3c161dab690'
        )
      )
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_agent_loop_v2_checkpoints
    VALIDATE CONSTRAINT
      omni_agent_loop_v2_checkpoints_engine_configuration_check
  `;
  await sql`
    DO $migration$
    DECLARE
      constraint_definition TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid)
      INTO constraint_definition
      FROM pg_constraint
      WHERE conname =
          'omni_agent_loop_v2_checkpoints_engine_configuration_check'
        AND conrelid = 'omni_agent_loop_v2_checkpoints'::regclass
        AND contype = 'c'
        AND convalidated;

      IF constraint_definition IS NULL
        OR constraint_definition NOT LIKE '%agent_loop_v2_read_only_canary_1%'
        OR constraint_definition NOT LIKE '%agent_loop_v2_model_text_canary_1%'
        OR constraint_definition NOT LIKE
          '%b9106374788a0e7f74dc00f79269848f7de0d57f210364a68151c3c161dab690%'
        OR EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname IN (
            'omni_agent_loop_v2_checkpoints_engine_version_id_check',
            'omni_agent_loop_v2_checkpoints_configuration_sha256_check'
          )
            AND conrelid = 'omni_agent_loop_v2_checkpoints'::regclass
        )
      THEN
        RAISE EXCEPTION 'Loop v2 model-text engine invariant is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureLoopV2TransitionCheckpoints(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_loop_v2_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      checkpoint_sha256 TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES omni_agent_runs(id),
      owner_actor_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      parent_checkpoint_sha256 TEXT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      trigger TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      terminal_disposition TEXT,
      retry_count INTEGER NOT NULL,
      replan_count INTEGER NOT NULL,
      execution_scope_sha256 TEXT NOT NULL,
      engine_version_id TEXT NOT NULL,
      contract_version_id TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      rollout_lifecycle_revision BIGINT NOT NULL,
      checkpoint_json JSONB NOT NULL,
      transitioned_at TIMESTAMPTZ NOT NULL,
      UNIQUE (tenant_id, run_id, sequence),
      CHECK (sequence BETWEEN 1 AND 10000),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (from_state IS NULL OR from_state IN (
        'understand', 'clarify', 'plan', 'act', 'observe', 'verify',
        'replan', 'finish'
      )),
      CHECK (to_state IN (
        'understand', 'clarify', 'plan', 'act', 'observe', 'verify',
        'replan', 'finish'
      )),
      CHECK (trigger IN (
        'started', 'ambiguity_detected', 'clarified', 'plan_bound',
        'action_started', 'action_succeeded', 'action_failed',
        'observation_recorded', 'verification_passed',
        'verification_failed', 'retry_scheduled', 'replan_bound',
        'canceled', 'budget_exhausted'
      )),
      CHECK (lifecycle_state IN ('active', 'waiting', 'terminal')),
      CHECK (terminal_disposition IS NULL OR terminal_disposition IN (
        'succeeded', 'failed', 'canceled'
      )),
      CHECK ((to_state = 'finish') = (terminal_disposition IS NOT NULL)),
      CHECK (retry_count BETWEEN 0 AND 2),
      CHECK (replan_count BETWEEN 0 AND 1),
      CHECK (checkpoint_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (execution_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (engine_version_id = 'agent_loop_v2_read_only_canary_1'),
      CHECK (contract_version_id = 'agent_loop_transition_checkpoint_v1'),
      CHECK (configuration_sha256 =
        'e0d1898a2de59ca2e4ec6fa6d5b5442347bae76e43700a29cfadbfa88a4e308b'),
      CHECK (rollout_generation >= 1),
      CHECK (rollout_lifecycle_revision >= 1),
      CHECK (checkpoint_json ->> 'checkpointId' = checkpoint_id),
      CHECK (checkpoint_json ->> 'checkpointSha256' = checkpoint_sha256),
      CHECK (checkpoint_json ->> 'tenantId' = tenant_id),
      CHECK (checkpoint_json ->> 'runId' = run_id),
      CHECK (checkpoint_json ->> 'ownerActorId' = owner_actor_id),
      CHECK ((checkpoint_json ->> 'sequence')::INTEGER = sequence),
      CHECK (checkpoint_json ->> 'toState' = to_state),
      CHECK (checkpoint_json ->> 'trigger' = trigger),
      CHECK (checkpoint_json ->> 'executionScopeSha256' = execution_scope_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_loop_v2_checkpoints_run_idx
    ON omni_agent_loop_v2_checkpoints (
      tenant_id, run_id, sequence DESC
    )
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_loop_v2_checkpoint_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Loop v2 transition checkpoints are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_agent_loop_v2_checkpoints_no_update_delete
    ON omni_agent_loop_v2_checkpoints
  `;
  await sql`
    CREATE TRIGGER omni_agent_loop_v2_checkpoints_no_update_delete
    BEFORE UPDATE OR DELETE ON omni_agent_loop_v2_checkpoints
    FOR EACH ROW EXECUTE FUNCTION omni_reject_loop_v2_checkpoint_mutation()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_agent_loop_v2_checkpoints_no_truncate
    ON omni_agent_loop_v2_checkpoints
  `;
  await sql`
    CREATE TRIGGER omni_agent_loop_v2_checkpoints_no_truncate
    BEFORE TRUNCATE ON omni_agent_loop_v2_checkpoints
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_loop_v2_checkpoint_mutation()
  `;
  await sql`REVOKE ALL ON TABLE omni_agent_loop_v2_checkpoints FROM PUBLIC`;
  await ensureTenantIsolationPolicies(sql);
  await sql`
    DROP POLICY IF EXISTS omni_agent_loop_v2_checkpoints_actor_scope
    ON omni_agent_loop_v2_checkpoints
  `;
  await sql`
    CREATE POLICY omni_agent_loop_v2_checkpoints_actor_scope
    ON omni_agent_loop_v2_checkpoints
    AS RESTRICTIVE
    FOR ALL
    USING (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
    WITH CHECK (
      omni_system_scope_enabled()
      OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
    )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT ON omni_agent_loop_v2_checkpoints TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT ON omni_agent_loop_v2_checkpoints TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
}

export async function ensureGovernedToolEffectReceipts(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_tool_executions
    ADD COLUMN IF NOT EXISTS effect_receipt JSONB
  `;
}

export async function ensureConversationThreads(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_threads (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'orchestrate',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_threads_tenant_updated_idx ON omni_threads (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_threads_actor_updated_idx ON omni_threads (tenant_id, actor_id, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_thread_turns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      thread_id TEXT NOT NULL REFERENCES omni_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      run_id TEXT REFERENCES omni_agent_runs(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_thread_turns_thread_created_idx ON omni_thread_turns (tenant_id, thread_id, created_at ASC)`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS thread_id TEXT REFERENCES omni_threads(id) ON DELETE SET NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_thread_idx ON omni_agent_runs (tenant_id, thread_id, started_at DESC)`;
}

export async function ensureRunCheckpointStore(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_run_checkpoints (
      schema_version INTEGER NOT NULL,
      checkpoint_id TEXT PRIMARY KEY,
      checkpoint_sha256 TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      executing_principal_type TEXT NOT NULL,
      executing_principal_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      parent_checkpoint_id TEXT,
      parent_checkpoint_sha256 TEXT,
      parent_sequence INTEGER,
      boundary_kind TEXT NOT NULL,
      boundary_phase TEXT NOT NULL,
      boundary_id TEXT NOT NULL,
      boundary_attempt INTEGER NOT NULL,
      execution_scope_sha256 TEXT NOT NULL,
      purpose_sha256 TEXT NOT NULL,
      rollout_capability_id TEXT NOT NULL,
      engine_version_id TEXT NOT NULL,
      contract_version_id TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL,
      rollout_generation INTEGER NOT NULL,
      rollout_lifecycle_revision INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      resume_disposition TEXT NOT NULL,
      checkpoint_json JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_run_checkpoints_schema_check
        CHECK (schema_version = 1),
      CONSTRAINT omni_run_checkpoints_id_check
        CHECK (length(checkpoint_id) BETWEEN 1 AND 240),
      CONSTRAINT omni_run_checkpoints_sha_check
        CHECK (checkpoint_sha256 ~ '^[a-f0-9]{64}$'),
      CONSTRAINT omni_run_checkpoints_scope_sha_check
        CHECK (
          execution_scope_sha256 ~ '^[a-f0-9]{64}$'
          AND purpose_sha256 ~ '^[a-f0-9]{64}$'
          AND configuration_sha256 ~ '^[a-f0-9]{64}$'
        ),
      CONSTRAINT omni_run_checkpoints_sequence_check
        CHECK (sequence BETWEEN 0 AND 1000000000),
      CONSTRAINT omni_run_checkpoints_parent_check
        CHECK (
          (sequence = 0 AND parent_checkpoint_id IS NULL
            AND parent_checkpoint_sha256 IS NULL AND parent_sequence IS NULL)
          OR
          (sequence > 0 AND parent_checkpoint_id IS NOT NULL
            AND parent_checkpoint_sha256 ~ '^[a-f0-9]{64}$'
            AND parent_sequence = sequence - 1)
        ),
      CONSTRAINT omni_run_checkpoints_principal_check
        CHECK (executing_principal_type IN ('user', 'agent', 'system')),
      CONSTRAINT omni_run_checkpoints_boundary_check
        CHECK (
          boundary_kind IN ('model', 'tool', 'approval', 'delegation', 'verifier')
          AND boundary_phase IN ('before', 'waiting', 'after')
          AND boundary_attempt BETWEEN 1 AND 1000000000
        ),
      CONSTRAINT omni_run_checkpoints_lifecycle_check
        CHECK (
          lifecycle_state IN ('active', 'waiting', 'terminal')
          AND resume_disposition IN (
            'resumable', 'awaiting_signal', 'not_resumable'
          )
        ),
      CONSTRAINT omni_run_checkpoints_rollout_check
        CHECK (
          rollout_generation BETWEEN 1 AND 1000000000
          AND rollout_lifecycle_revision BETWEEN 0 AND 1000000000
        ),
      CONSTRAINT omni_run_checkpoints_json_check
        CHECK (
          jsonb_typeof(checkpoint_json) = 'object'
          AND checkpoint_json ->> 'checkpointId' = checkpoint_id
          AND checkpoint_json ->> 'checkpointSha256' = checkpoint_sha256
          AND checkpoint_json ->> 'runId' = run_id
          AND checkpoint_json #>> '{executionScope,tenantId}' = tenant_id
          AND checkpoint_json #>> '{executionScope,initiatingActorId}' = actor_id
          AND checkpoint_json #>> '{executionScope,executingPrincipalType}' =
            executing_principal_type
          AND checkpoint_json #>> '{executionScope,executingPrincipalId}' =
            executing_principal_id
          AND checkpoint_json #>> '{executionScope,executionScopeSha256}' =
            execution_scope_sha256
          AND checkpoint_json #>> '{executionScope,purposeSha256}' = purpose_sha256
          AND (checkpoint_json ->> 'sequence')::INTEGER = sequence
          AND checkpoint_json #>> '{boundary,kind}' = boundary_kind
          AND checkpoint_json #>> '{boundary,phase}' = boundary_phase
          AND checkpoint_json #>> '{boundary,boundaryId}' = boundary_id
          AND (checkpoint_json #>> '{boundary,attempt}')::INTEGER =
            boundary_attempt
        ),
      CONSTRAINT omni_run_checkpoints_identity_unique
        UNIQUE (tenant_id, run_id, checkpoint_id),
      CONSTRAINT omni_run_checkpoints_sequence_unique
        UNIQUE (tenant_id, run_id, sequence),
      CONSTRAINT omni_run_checkpoints_parent_fk
        FOREIGN KEY (tenant_id, run_id, parent_checkpoint_id)
        REFERENCES omni_run_checkpoints (tenant_id, run_id, checkpoint_id)
        DEFERRABLE INITIALLY IMMEDIATE
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_run_checkpoint_state_references (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      reference_kind TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      reference_sha256 TEXT NOT NULL,
      version_id TEXT,
      CONSTRAINT omni_run_checkpoint_references_ordinal_check
        CHECK (ordinal BETWEEN 0 AND 63),
      CONSTRAINT omni_run_checkpoint_references_kind_check
        CHECK (reference_kind IN (
          'run_record', 'workflow_run', 'conversation', 'context_manifest',
          'harness_manifest', 'model_turn', 'model_continuation',
          'tool_execution', 'approval_request', 'approval_decision',
          'delegation', 'delegation_signal', 'verifier_request',
          'verifier_receipt', 'effect_intent', 'effect_receipt', 'artifact'
        )),
      CONSTRAINT omni_run_checkpoint_references_id_check
        CHECK (
          length(reference_id) BETWEEN 1 AND 240
          AND (version_id IS NULL OR length(version_id) BETWEEN 1 AND 240)
        ),
      CONSTRAINT omni_run_checkpoint_references_sha_check
        CHECK (reference_sha256 ~ '^[a-f0-9]{64}$'),
      CONSTRAINT omni_run_checkpoint_references_pk
        PRIMARY KEY (checkpoint_id, ordinal),
      CONSTRAINT omni_run_checkpoint_references_identity_unique
        UNIQUE (tenant_id, run_id, checkpoint_id, reference_kind, reference_id),
      CONSTRAINT omni_run_checkpoint_references_checkpoint_fk
        FOREIGN KEY (tenant_id, run_id, checkpoint_id)
        REFERENCES omni_run_checkpoints (tenant_id, run_id, checkpoint_id)
        DEFERRABLE INITIALLY IMMEDIATE
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_run_checkpoints_tenant_run_recorded_idx
    ON omni_run_checkpoints (tenant_id, run_id, recorded_at DESC, sequence DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_run_checkpoint_references_lookup_idx
    ON omni_run_checkpoint_state_references
      (tenant_id, reference_kind, reference_id, checkpoint_id)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_run_checkpoint_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Run checkpoints are append-only' USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoints'::regclass
          AND tgname = 'omni_run_checkpoints_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoints_immutable
        BEFORE UPDATE OR DELETE ON omni_run_checkpoints
        FOR EACH ROW EXECUTE FUNCTION omni_reject_run_checkpoint_mutation();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoints'::regclass
          AND tgname = 'omni_run_checkpoints_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoints_no_truncate
        BEFORE TRUNCATE ON omni_run_checkpoints
        FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_run_checkpoint_mutation();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoint_state_references'::regclass
          AND tgname = 'omni_run_checkpoint_references_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoint_references_immutable
        BEFORE UPDATE OR DELETE ON omni_run_checkpoint_state_references
        FOR EACH ROW EXECUTE FUNCTION omni_reject_run_checkpoint_mutation();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoint_state_references'::regclass
          AND tgname = 'omni_run_checkpoint_references_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoint_references_no_truncate
        BEFORE TRUNCATE ON omni_run_checkpoint_state_references
        FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_run_checkpoint_mutation();
      END IF;
    END
    $migration$
  `;

  await ensureTenantIsolationPolicies(sql);

  await sql`
    DO $migration$
    DECLARE
      relation_name TEXT;
    BEGIN
      FOREACH relation_name IN ARRAY ARRAY[
        'omni_run_checkpoints',
        'omni_run_checkpoint_state_references'
      ] LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class relation
          WHERE relation.oid = to_regclass(relation_name)
            AND relation.relrowsecurity
            AND relation.relforcerowsecurity
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid = to_regclass(relation_name)
            AND polname = 'omni_tenant_isolation'
            AND pg_get_expr(polqual, polrelid) =
              'omni_tenant_visible(tenant_id)'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_tenant_visible(tenant_id)'
        ) OR (
          SELECT count(*)
          FROM pg_trigger
          WHERE tgrelid = to_regclass(relation_name)
            AND NOT tgisinternal
            AND tgenabled = 'O'
        ) <> 2 THEN
          RAISE EXCEPTION 'Run checkpoint storage boundary is invalid'
            USING ERRCODE = '55000';
        END IF;
      END LOOP;
    END
    $migration$
  `;
}

export async function ensureRunCheckpointResumeClaims(sql: SqlClient) {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_run_checkpoints_resume_identity_idx
    ON omni_run_checkpoints (
      tenant_id, run_id, checkpoint_id, checkpoint_sha256
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_run_checkpoint_resume_claims (
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_sha256 TEXT NOT NULL,
      operation_job_id TEXT NOT NULL,
      lease_generation BIGINT NOT NULL,
      claim_token_sha256 TEXT NOT NULL,
      lease_owner_sha256 TEXT NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT omni_run_checkpoint_resume_claims_pkey
        PRIMARY KEY (tenant_id, run_id, checkpoint_id),
      CONSTRAINT omni_run_checkpoint_resume_claims_checkpoint_fk
        FOREIGN KEY (
          tenant_id, run_id, checkpoint_id, checkpoint_sha256
        )
        REFERENCES omni_run_checkpoints (
          tenant_id, run_id, checkpoint_id, checkpoint_sha256
        )
        DEFERRABLE INITIALLY IMMEDIATE,
      CONSTRAINT omni_run_checkpoint_resume_claims_ids_check CHECK (
        length(tenant_id) BETWEEN 1 AND 240
        AND length(run_id) BETWEEN 1 AND 240
        AND length(checkpoint_id) BETWEEN 1 AND 240
        AND length(operation_job_id) BETWEEN 1 AND 240
      ),
      CONSTRAINT omni_run_checkpoint_resume_claims_hashes_check CHECK (
        checkpoint_sha256 ~ '^[a-f0-9]{64}$'
        AND claim_token_sha256 ~ '^[a-f0-9]{64}$'
        AND lease_owner_sha256 ~ '^[a-f0-9]{64}$'
      ),
      CONSTRAINT omni_run_checkpoint_resume_claims_generation_check
        CHECK (lease_generation BETWEEN 1 AND 9007199254740991),
      CONSTRAINT omni_run_checkpoint_resume_claims_status_check
        CHECK (status IN ('claimed', 'completed')),
      CONSTRAINT omni_run_checkpoint_resume_claims_timestamps_check CHECK (
        claimed_at <= updated_at
        AND claimed_at < lease_expires_at
        AND (status = 'completed') = (completed_at IS NOT NULL)
        AND (completed_at IS NULL OR claimed_at <= completed_at)
        AND (completed_at IS NULL OR completed_at <= updated_at)
      )
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_run_checkpoint_resume_claims_one_active_run_idx
    ON omni_run_checkpoint_resume_claims (tenant_id, run_id)
    WHERE status = 'claimed'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS
      omni_run_checkpoint_resume_claims_expiry_idx
    ON omni_run_checkpoint_resume_claims (tenant_id, lease_expires_at)
    WHERE status = 'claimed'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_run_checkpoint_resume_claim()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Run checkpoint resume claims cannot be deleted'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'claimed'
          OR NEW.lease_generation <> 1
          OR NEW.completed_at IS NOT NULL
          OR NEW.lease_expires_at <= statement_timestamp()
        THEN
          RAISE EXCEPTION 'Run checkpoint resume claims must start claimed at generation one'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'Completed run checkpoint resume claims are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.run_id IS DISTINCT FROM OLD.run_id
        OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
        OR NEW.checkpoint_sha256 IS DISTINCT FROM OLD.checkpoint_sha256
        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      THEN
        RAISE EXCEPTION 'Run checkpoint resume claim identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'Run checkpoint resume claim time moved backward'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.status = 'completed' THEN
        IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
          OR NEW.claim_token_sha256 IS DISTINCT FROM OLD.claim_token_sha256
          OR NEW.lease_owner_sha256 IS DISTINCT FROM OLD.lease_owner_sha256
          OR NEW.operation_job_id IS DISTINCT FROM OLD.operation_job_id
          OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
          OR NEW.completed_at IS NULL
        THEN
          RAISE EXCEPTION 'Run checkpoint resume completion changed its fence'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.status <> 'claimed' OR NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Run checkpoint resume claim transition is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.lease_generation = OLD.lease_generation THEN
        IF NEW.claim_token_sha256 IS DISTINCT FROM OLD.claim_token_sha256
          OR NEW.lease_owner_sha256 IS DISTINCT FROM OLD.lease_owner_sha256
          OR NEW.operation_job_id IS DISTINCT FROM OLD.operation_job_id
          OR NEW.lease_expires_at < OLD.lease_expires_at
          OR NEW.lease_expires_at <= statement_timestamp()
        THEN
          RAISE EXCEPTION 'Run checkpoint resume heartbeat changed its fence'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.lease_generation = OLD.lease_generation + 1
        AND OLD.lease_expires_at <= statement_timestamp()
        AND NEW.lease_expires_at > statement_timestamp()
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Run checkpoint resume reclaim is not fenced'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_run_checkpoint_resume_claim_truncate()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Run checkpoint resume claims cannot be truncated'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoint_resume_claims'::regclass
          AND tgname = 'omni_run_checkpoint_resume_claims_protected'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoint_resume_claims_protected
        BEFORE INSERT OR UPDATE OR DELETE ON omni_run_checkpoint_resume_claims
        FOR EACH ROW EXECUTE FUNCTION omni_protect_run_checkpoint_resume_claim();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoint_resume_claims'::regclass
          AND tgname = 'omni_run_checkpoint_resume_claims_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_run_checkpoint_resume_claims_no_truncate
        BEFORE TRUNCATE ON omni_run_checkpoint_resume_claims
        FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_run_checkpoint_resume_claim_truncate();
      END IF;
    END
    $migration$
  `;

  await sql`
    REVOKE ALL ON TABLE omni_run_checkpoint_resume_claims FROM PUBLIC
  `;
  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_run_checkpoint_resume_claims'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_run_checkpoint_resume_claims'::regclass
          AND polname = 'omni_tenant_isolation'
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_run_checkpoint_resume_claims'::regclass
          AND NOT tgisinternal AND tgenabled = 'O'
      ) <> 2 THEN
        RAISE EXCEPTION 'Run checkpoint resume claim boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
