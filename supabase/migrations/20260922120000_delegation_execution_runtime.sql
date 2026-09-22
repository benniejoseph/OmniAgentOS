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

  IF latest_version IS DISTINCT FROM 195 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 195
      AND name = 'moltbook_autonomy_privilege_repair_v1'
      AND checksum = 'c02b2ca195cbb00c206320eb2074fed7981c282c356f1d4320c6c1ac866adf94'
  ) <> 1 THEN
    RAISE EXCEPTION 'Delegation execution runtime predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Canonical V2 delegation executions retain their complete authority envelope.
-- Mutable lifecycle fields are deliberately separate from the immutable
-- contract, context, identity, runtime assignment, and root-budget allocation.
CREATE TABLE public.omni_delegation_budget_ledgers (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  root_execution_id TEXT NOT NULL,
  limits JSONB NOT NULL,
  limits_sha256 TEXT NOT NULL,
  reserved JSONB NOT NULL,
  lifecycle_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, root_execution_id),
  CHECK (schema_version = 1),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (char_length(root_execution_id) BETWEEN 1 AND 240),
  CHECK (jsonb_typeof(limits) = 'object'),
  CHECK (jsonb_typeof(reserved) = 'object'),
  CHECK (limits ?& ARRAY[
    'modelTurns', 'tokens', 'costMicrousd', 'wallTimeMs', 'toolCalls',
    'browserActions', 'agents', 'fanOut', 'retries', 'replans'
  ]),
  CHECK (reserved ?& ARRAY[
    'modelTurns', 'tokens', 'costMicrousd', 'wallTimeMs', 'toolCalls',
    'browserActions', 'agents', 'fanOut', 'retries', 'replans'
  ]),
  CHECK (limits_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (lifecycle_revision BETWEEN 0 AND 9007199254740991),
  CHECK (created_at <= updated_at),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (root_execution_id)
    REFERENCES public.omni_agent_runs (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.omni_delegation_executions (
  schema_version SMALLINT NOT NULL DEFAULT 1,
  tenant_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  root_execution_id TEXT NOT NULL,
  parent_execution_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  compatibility_task_id TEXT,
  contract_id TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  context_capsule_id TEXT NOT NULL,
  context_capsule_sha256 TEXT NOT NULL,
  delegate_agent_id TEXT NOT NULL,
  delegate_principal_id TEXT NOT NULL,
  runtime_assignment_id TEXT NOT NULL,
  runtime_assignment_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL,
  budget_limits JSONB NOT NULL,
  budget_limits_sha256 TEXT NOT NULL,
  budget_ledger_revision BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  lifecycle_revision BIGINT NOT NULL DEFAULT 0,
  contract JSONB NOT NULL,
  context_capsule JSONB NOT NULL,
  runtime_assignment JSONB NOT NULL,
  result JSONB,
  result_sha256 TEXT,
  verification JSONB,
  verification_sha256 TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  accept_by TIMESTAMPTZ NOT NULL,
  complete_by TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, execution_id),
  UNIQUE (tenant_id, delegation_id),
  UNIQUE (tenant_id, child_run_id),
  CHECK (schema_version = 1),
  CHECK (char_length(execution_id) BETWEEN 1 AND 240),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
  CHECK (char_length(root_execution_id) BETWEEN 1 AND 240),
  CHECK (char_length(parent_execution_id) BETWEEN 1 AND 240),
  CHECK (char_length(child_run_id) BETWEEN 1 AND 240),
  CHECK (char_length(delegation_id) BETWEEN 1 AND 240),
  CHECK (compatibility_task_id IS NULL OR char_length(compatibility_task_id) BETWEEN 1 AND 240),
  CHECK (char_length(contract_id) BETWEEN 1 AND 240),
  CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(context_capsule_id) BETWEEN 1 AND 240),
  CHECK (context_capsule_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (char_length(delegate_agent_id) BETWEEN 1 AND 240),
  CHECK (char_length(delegate_principal_id) BETWEEN 1 AND 240),
  CHECK (char_length(runtime_assignment_id) BETWEEN 1 AND 240),
  CHECK (runtime_assignment_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (mode IN ('isolated', 'fork', 'team')),
  CHECK (jsonb_typeof(budget_limits) = 'object'),
  CHECK (budget_limits ?& ARRAY[
    'modelTurns', 'tokens', 'costMicrousd', 'wallTimeMs', 'toolCalls',
    'browserActions', 'agents', 'fanOut', 'retries', 'replans'
  ]),
  CHECK (budget_limits_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (budget_ledger_revision BETWEEN 1 AND 9007199254740991),
  CHECK (state IN (
    'queued', 'running', 'waiting', 'completed_proposed', 'verified',
    'rejected', 'failed', 'canceled', 'expired'
  )),
  CHECK (lifecycle_revision BETWEEN 0 AND 9007199254740991),
  CHECK (jsonb_typeof(contract) = 'object'),
  CHECK (jsonb_typeof(context_capsule) = 'object'),
  CHECK (jsonb_typeof(runtime_assignment) = 'object'),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CHECK (verification IS NULL OR jsonb_typeof(verification) = 'object'),
  CHECK ((result IS NULL) = (result_sha256 IS NULL)),
  CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((verification IS NULL) = (verification_sha256 IS NULL)),
  CHECK (verification_sha256 IS NULL OR verification_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 120),
  CHECK (created_at <= updated_at),
  CHECK (created_at <= accept_by AND accept_by < complete_by),
  CHECK ((state IN ('verified', 'rejected', 'failed', 'canceled', 'expired')) = (terminal_at IS NOT NULL)),
  CHECK ((state IN ('completed_proposed', 'verified', 'rejected')) = (result IS NOT NULL)),
  CHECK ((state IN ('verified', 'rejected')) = (verification IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CHECK (contract->>'version' = 'delegation-execution-contract:2'),
  CHECK (contract->>'contractId' = contract_id),
  CHECK (contract->>'contractSha256' = contract_sha256),
  CHECK (contract->>'delegationId' = delegation_id),
  CHECK (contract->>'mode' = mode),
  CHECK (contract->'lineage'->>'tenantId' = tenant_id),
  CHECK (contract->'lineage'->>'initiatingActorId' = owner_actor_id),
  CHECK (contract->'lineage'->>'rootExecutionId' = root_execution_id),
  CHECK (contract->'lineage'->>'parentExecutionId' = parent_execution_id),
  CHECK (contract->'delegateIdentity'->>'runId' = child_run_id),
  CHECK (contract->'delegateIdentity'->>'logicalAgentId' = delegate_agent_id),
  CHECK (contract->'delegateIdentity'->>'principalId' = delegate_principal_id),
  CHECK (contract->'runtimeAssignment'->>'assignmentId' = runtime_assignment_id),
  CHECK (contract->'runtimeAssignment'->>'assignmentSha256' = runtime_assignment_sha256),
  CHECK (contract->'contextCapsule'->>'capsuleId' = context_capsule_id),
  CHECK (contract->'contextCapsule'->>'capsuleSha256' = context_capsule_sha256),
  CHECK (context_capsule->>'capsuleId' = context_capsule_id),
  CHECK (context_capsule->>'capsuleSha256' = context_capsule_sha256),
  CHECK (runtime_assignment->>'assignmentId' = runtime_assignment_id),
  CHECK (runtime_assignment->>'assignmentSha256' = runtime_assignment_sha256),
  CHECK (child_run_id = execution_id),
  FOREIGN KEY (owner_actor_id)
    REFERENCES public.omni_auth_users (actor_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (root_execution_id)
    REFERENCES public.omni_agent_runs (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (parent_execution_id)
    REFERENCES public.omni_agent_runs (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (child_run_id)
    REFERENCES public.omni_agent_runs (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_actor_id, root_execution_id)
    REFERENCES public.omni_delegation_budget_ledgers (
      tenant_id, owner_actor_id, root_execution_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX omni_delegation_executions_parent_idx
ON public.omni_delegation_executions (
  tenant_id, owner_actor_id, parent_execution_id, created_at, execution_id
);

CREATE INDEX omni_delegation_executions_active_idx
ON public.omni_delegation_executions (tenant_id, owner_actor_id, state, updated_at)
WHERE state IN ('queued', 'running', 'waiting', 'completed_proposed');

CREATE OR REPLACE FUNCTION public.omni_protect_delegation_budget_ledger_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Delegation budget ledgers cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_revision <> 0
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'Initial delegation budget ledger is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.schema_version, NEW.tenant_id, NEW.owner_actor_id,
    NEW.root_execution_id, NEW.limits, NEW.limits_sha256, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.tenant_id, OLD.owner_actor_id,
    OLD.root_execution_id, OLD.limits, OLD.limits_sha256, OLD.created_at
  ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Delegation budget ledger identity or revision is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.omni_protect_delegation_execution_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Delegation executions cannot be removed'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued'
      OR NEW.lifecycle_revision <> 0
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
      OR NEW.terminal_at IS NOT NULL
      OR NEW.result IS NOT NULL
      OR NEW.verification IS NOT NULL
      OR NEW.failure_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'Initial delegation execution is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.schema_version, NEW.tenant_id, NEW.execution_id,
    NEW.owner_actor_id, NEW.root_execution_id, NEW.parent_execution_id,
    NEW.child_run_id, NEW.delegation_id, NEW.compatibility_task_id,
    NEW.contract_id, NEW.contract_sha256, NEW.context_capsule_id,
    NEW.context_capsule_sha256, NEW.delegate_agent_id,
    NEW.delegate_principal_id, NEW.runtime_assignment_id,
    NEW.runtime_assignment_sha256, NEW.mode, NEW.budget_limits,
    NEW.budget_limits_sha256, NEW.budget_ledger_revision, NEW.contract,
    NEW.context_capsule, NEW.runtime_assignment, NEW.created_at,
    NEW.accept_by, NEW.complete_by
  ) IS DISTINCT FROM ROW(
    OLD.schema_version, OLD.tenant_id, OLD.execution_id,
    OLD.owner_actor_id, OLD.root_execution_id, OLD.parent_execution_id,
    OLD.child_run_id, OLD.delegation_id, OLD.compatibility_task_id,
    OLD.contract_id, OLD.contract_sha256, OLD.context_capsule_id,
    OLD.context_capsule_sha256, OLD.delegate_agent_id,
    OLD.delegate_principal_id, OLD.runtime_assignment_id,
    OLD.runtime_assignment_sha256, OLD.mode, OLD.budget_limits,
    OLD.budget_limits_sha256, OLD.budget_ledger_revision, OLD.contract,
    OLD.context_capsule, OLD.runtime_assignment, OLD.created_at,
    OLD.accept_by, OLD.complete_by
  ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Delegation execution identity or revision is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('running', 'failed', 'canceled', 'expired'))
    OR (OLD.state = 'running' AND NEW.state IN ('waiting', 'completed_proposed', 'failed', 'canceled', 'expired'))
    OR (OLD.state = 'waiting' AND NEW.state IN ('running', 'failed', 'canceled', 'expired'))
    OR (OLD.state = 'completed_proposed' AND NEW.state IN ('verified', 'rejected', 'failed', 'canceled', 'expired'))
  ) THEN
    RAISE EXCEPTION 'Delegation execution transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'running' AND OLD.state = 'queued' AND NEW.updated_at >= NEW.accept_by THEN
    RAISE EXCEPTION 'Delegation execution acceptance deadline has expired'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'expired' AND NEW.updated_at < NEW.complete_by THEN
    RAISE EXCEPTION 'Delegation execution cannot expire before its deadline'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> 'expired' AND NEW.updated_at >= NEW.complete_by THEN
    RAISE EXCEPTION 'Delegation execution completion deadline has expired'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER omni_delegation_budget_ledger_protect
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_delegation_budget_ledgers
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_delegation_budget_ledger_v1();

CREATE TRIGGER omni_delegation_budget_ledger_no_truncate
BEFORE TRUNCATE ON public.omni_delegation_budget_ledgers
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_delegation_budget_ledger_v1();

CREATE TRIGGER omni_delegation_execution_protect
BEFORE INSERT OR UPDATE OR DELETE ON public.omni_delegation_executions
FOR EACH ROW EXECUTE FUNCTION public.omni_protect_delegation_execution_v1();

CREATE TRIGGER omni_delegation_execution_no_truncate
BEFORE TRUNCATE ON public.omni_delegation_executions
FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_delegation_execution_v1();

ALTER TABLE public.omni_delegation_budget_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_delegation_budget_ledgers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_delegation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_delegation_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY omni_delegation_budget_ledgers_actor
ON public.omni_delegation_budget_ledgers AS RESTRICTIVE FOR ALL
USING (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

CREATE POLICY omni_delegation_executions_actor
ON public.omni_delegation_executions AS RESTRICTIVE FOR ALL
USING (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

REVOKE ALL ON TABLE public.omni_delegation_budget_ledgers FROM PUBLIC;
REVOKE ALL ON TABLE public.omni_delegation_executions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_delegation_budget_ledger_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.omni_protect_delegation_execution_v1() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_delegation_budget_ledgers FROM omni_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON public.omni_delegation_budget_ledgers TO omni_runtime';
    EXECUTE 'GRANT UPDATE (reserved, lifecycle_revision, updated_at) ON public.omni_delegation_budget_ledgers TO omni_runtime';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_delegation_executions FROM omni_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON public.omni_delegation_executions TO omni_runtime';
    EXECUTE 'GRANT UPDATE (state, lifecycle_revision, result, result_sha256, verification, verification_sha256, failure_code, updated_at, terminal_at) ON public.omni_delegation_executions TO omni_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.omni_delegation_budget_ledgers FROM omni_maintenance';
    EXECUTE 'GRANT SELECT, INSERT ON public.omni_delegation_budget_ledgers TO omni_maintenance';
    EXECUTE 'GRANT UPDATE (reserved, lifecycle_revision, updated_at) ON public.omni_delegation_budget_ledgers TO omni_maintenance';
    EXECUTE 'REVOKE ALL ON TABLE public.omni_delegation_executions FROM omni_maintenance';
    EXECUTE 'GRANT SELECT, INSERT ON public.omni_delegation_executions TO omni_maintenance';
    EXECUTE 'GRANT UPDATE (state, lifecycle_revision, result, result_sha256, verification, verification_sha256, failure_code, updated_at, terminal_at) ON public.omni_delegation_executions TO omni_maintenance';
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_delegation_budget_ledgers'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.omni_delegation_executions'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.omni_delegation_budget_ledgers'::regclass
      AND polname = 'omni_delegation_budget_ledgers_actor'
      AND NOT polpermissive AND polcmd = '*'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.omni_delegation_executions'::regclass
      AND polname = 'omni_delegation_executions_actor'
      AND NOT polpermissive AND polcmd = '*'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.omni_delegation_executions'::regclass
      AND tgname = 'omni_delegation_execution_protect'
      AND NOT tgisinternal AND tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.omni_delegation_budget_ledgers'::regclass
      AND tgname = 'omni_delegation_budget_ledger_protect'
      AND NOT tgisinternal AND tgenabled = 'O'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('omni_delegation_budget_ledgers', 'omni_delegation_executions')
      AND grantee IN ('omni_runtime', 'omni_maintenance')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Delegation execution runtime boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  196,
  'delegation_execution_runtime_v1',
  '0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac',
  clock_timestamp()
);

COMMIT;
