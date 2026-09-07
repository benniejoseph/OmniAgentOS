// Kept executable because controlled local migrations run from the bundled
// application. The matching Supabase migration pins the same versioned schema.
export const CUSTOMER_SUCCESS_WORKFLOW_SCHEMA_SQL = `
  CREATE TABLE omni_customer_success_workflow_run_revisions (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_revision_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    owner_actor_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    definition_sha256 TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    project_id TEXT NOT NULL,
    outcome_status TEXT NOT NULL,
    outcome_receipt_sha256 TEXT NOT NULL,
    run_sha256 TEXT NOT NULL,
    run_snapshot JSONB NOT NULL,
    allowed_purpose_ids TEXT[] NOT NULL,
    mutation_idempotency_sha256 TEXT NOT NULL,
    mutation_request_sha256 TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_revision_id),
    UNIQUE (tenant_id, workspace_id, run_id, revision),
    UNIQUE (tenant_id, workspace_id, owner_actor_id, mutation_idempotency_sha256),
    FOREIGN KEY (tenant_id, workspace_id, account_id)
      REFERENCES omni_customer_accounts (tenant_id, workspace_id, account_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES omni_projects (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (workspace_id ~ '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'),
    CHECK (run_id ~ '^customer-success-run:[a-f0-9]{64}$'),
    CHECK (run_revision_id = run_id || ':v' || revision::TEXT),
    CHECK (revision >= 1),
    CHECK (workflow_id IN (
      'onboarding', 'adoption_review', 'risk_escalation', 'renewal_planning',
      'qbr_ebr', 'meeting_prep_follow_up', 'support_escalation',
      'expansion_discovery'
    )),
    CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (outcome_status IN ('in_progress', 'completed', 'blocked', 'cancelled')),
    CHECK (outcome_receipt_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (run_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (mutation_idempotency_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (mutation_request_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read']::TEXT[]),
    CHECK (run_snapshot ->> 'runId' = run_id),
    CHECK (run_snapshot ->> 'runRevisionId' = run_revision_id),
    CHECK ((run_snapshot ->> 'revision')::INTEGER = revision),
    CHECK (run_snapshot ->> 'accountId' = account_id),
    CHECK (run_snapshot ->> 'workflowId' = workflow_id),
    CHECK (run_snapshot ->> 'definitionSha256' = definition_sha256),
    CHECK (run_snapshot ->> 'inputSha256' = input_sha256),
    CHECK (run_snapshot ->> 'projectId' = project_id),
    CHECK (run_snapshot -> 'outcome' ->> 'status' = outcome_status),
    CHECK (run_snapshot -> 'outcome' ->> 'receiptSha256' = outcome_receipt_sha256),
    CHECK (run_snapshot ->> 'runSha256' = run_sha256)
  );

  CREATE TABLE omni_customer_success_workflow_runs (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    current_revision_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL,
    owner_actor_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    definition_sha256 TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    project_id TEXT NOT NULL,
    outcome_status TEXT NOT NULL,
    outcome_receipt_sha256 TEXT NOT NULL,
    run_sha256 TEXT NOT NULL,
    run_snapshot JSONB NOT NULL,
    allowed_purpose_ids TEXT[] NOT NULL,
    start_request_sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id),
    UNIQUE (tenant_id, workspace_id, project_id),
    FOREIGN KEY (tenant_id, workspace_id, run_id, current_revision)
      REFERENCES omni_customer_success_workflow_run_revisions (
        tenant_id, workspace_id, run_id, revision
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (run_id ~ '^customer-success-run:[a-f0-9]{64}$'),
    CHECK (current_revision_id = run_id || ':v' || current_revision::TEXT),
    CHECK (current_revision >= 1),
    CHECK (workflow_id IN (
      'onboarding', 'adoption_review', 'risk_escalation', 'renewal_planning',
      'qbr_ebr', 'meeting_prep_follow_up', 'support_escalation',
      'expansion_discovery'
    )),
    CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (outcome_status IN ('in_progress', 'completed', 'blocked', 'cancelled')),
    CHECK (outcome_receipt_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (run_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (start_request_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (allowed_purpose_ids = ARRAY['customer_success.account.read']::TEXT[]),
    CHECK (run_snapshot ->> 'runId' = run_id),
    CHECK (run_snapshot ->> 'runRevisionId' = current_revision_id),
    CHECK ((run_snapshot ->> 'revision')::INTEGER = current_revision),
    CHECK (run_snapshot ->> 'accountId' = account_id),
    CHECK (run_snapshot ->> 'workflowId' = workflow_id),
    CHECK (run_snapshot ->> 'definitionSha256' = definition_sha256),
    CHECK (run_snapshot ->> 'inputSha256' = input_sha256),
    CHECK (run_snapshot ->> 'projectId' = project_id),
    CHECK (run_snapshot -> 'outcome' ->> 'status' = outcome_status),
    CHECK (run_snapshot -> 'outcome' ->> 'receiptSha256' = outcome_receipt_sha256),
    CHECK (run_snapshot ->> 'runSha256' = run_sha256),
    CHECK (updated_at >= created_at)
  );

  CREATE INDEX omni_customer_success_workflow_account_idx
    ON omni_customer_success_workflow_runs (
      tenant_id, workspace_id, account_id, updated_at DESC
    );
  CREATE INDEX omni_customer_success_workflow_status_idx
    ON omni_customer_success_workflow_runs (
      tenant_id, workspace_id, outcome_status, updated_at DESC
    );
  CREATE INDEX omni_customer_success_workflow_history_idx
    ON omni_customer_success_workflow_run_revisions (
      tenant_id, workspace_id, run_id, revision DESC
    );

  CREATE FUNCTION omni_protect_customer_success_workflow_projection_v1()
  RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public AS $function$
  BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
      RAISE EXCEPTION 'Customer-success workflow projections cannot be removed'
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.current_revision <> 1
        OR NEW.outcome_status <> 'in_progress'
        OR NEW.created_at <> NEW.updated_at
      THEN
        RAISE EXCEPTION 'Initial customer-success workflow projection is invalid'
          USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.tenant_id <> NEW.tenant_id
      OR OLD.workspace_id <> NEW.workspace_id
      OR OLD.account_id <> NEW.account_id
      OR OLD.run_id <> NEW.run_id
      OR OLD.owner_actor_id <> NEW.owner_actor_id
      OR OLD.workflow_id <> NEW.workflow_id
      OR OLD.definition_sha256 <> NEW.definition_sha256
      OR OLD.input_sha256 <> NEW.input_sha256
      OR OLD.project_id <> NEW.project_id
      OR OLD.allowed_purpose_ids <> NEW.allowed_purpose_ids
      OR OLD.start_request_sha256 <> NEW.start_request_sha256
      OR OLD.created_at <> NEW.created_at
      OR OLD.outcome_status IN ('completed', 'cancelled')
      OR NEW.outcome_status = 'in_progress'
      OR NEW.current_revision <> OLD.current_revision + 1
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'Customer-success workflow projection transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $function$;

  CREATE TRIGGER omni_customer_success_workflow_run_revisions_immutable
    BEFORE UPDATE OR DELETE ON omni_customer_success_workflow_run_revisions
    FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_evidence_v1();
  CREATE TRIGGER omni_customer_success_workflow_run_revisions_no_truncate
    BEFORE TRUNCATE ON omni_customer_success_workflow_run_revisions
    FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_evidence_v1();
  CREATE TRIGGER omni_customer_success_workflow_runs_protected
    BEFORE INSERT OR UPDATE OR DELETE ON omni_customer_success_workflow_runs
    FOR EACH ROW EXECUTE FUNCTION omni_protect_customer_success_workflow_projection_v1();
  CREATE TRIGGER omni_customer_success_workflow_runs_no_truncate
    BEFORE TRUNCATE ON omni_customer_success_workflow_runs
    FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_customer_success_workflow_projection_v1();

  ALTER TABLE omni_customer_success_workflow_run_revisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE omni_customer_success_workflow_run_revisions FORCE ROW LEVEL SECURITY;
  ALTER TABLE omni_customer_success_workflow_runs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE omni_customer_success_workflow_runs FORCE ROW LEVEL SECURITY;

  CREATE POLICY omni_tenant_isolation ON omni_customer_success_workflow_run_revisions
    FOR ALL USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id));
  CREATE POLICY omni_tenant_isolation ON omni_customer_success_workflow_runs
    FOR ALL USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id));
  CREATE POLICY omni_customer_success_workflow_revisions_read_scope
    ON omni_customer_success_workflow_run_revisions AS RESTRICTIVE FOR SELECT
    USING (
      'customer_success.account.read' = ANY(allowed_purpose_ids)
      AND omni_customer_workspace_access_v1_allows(
        tenant_id, workspace_id, owner_actor_id, FALSE
      )
    );
  CREATE POLICY omni_customer_success_workflow_revisions_insert_scope
    ON omni_customer_success_workflow_run_revisions AS RESTRICTIVE FOR INSERT
    WITH CHECK (omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    ));
  CREATE POLICY omni_customer_success_workflow_runs_read_scope
    ON omni_customer_success_workflow_runs AS RESTRICTIVE FOR SELECT
    USING (
      'customer_success.account.read' = ANY(allowed_purpose_ids)
      AND omni_customer_workspace_access_v1_allows(
        tenant_id, workspace_id, owner_actor_id, FALSE
      )
    );
  CREATE POLICY omni_customer_success_workflow_runs_insert_scope
    ON omni_customer_success_workflow_runs AS RESTRICTIVE FOR INSERT
    WITH CHECK (omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    ));
  CREATE POLICY omni_customer_success_workflow_runs_update_scope
    ON omni_customer_success_workflow_runs AS RESTRICTIVE FOR UPDATE
    USING (omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    )) WITH CHECK (omni_customer_workspace_access_v1_allows(
      tenant_id, workspace_id, owner_actor_id, TRUE
    ));

  REVOKE ALL ON FUNCTION omni_protect_customer_success_workflow_projection_v1()
    FROM PUBLIC;

  DO $migration$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
      REVOKE ALL ON TABLE omni_customer_success_workflow_run_revisions,
        omni_customer_success_workflow_runs FROM omni_runtime;
      GRANT SELECT, INSERT ON omni_customer_success_workflow_run_revisions
        TO omni_runtime;
      GRANT SELECT, INSERT, UPDATE ON omni_customer_success_workflow_runs
        TO omni_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
      GRANT SELECT, INSERT ON omni_customer_success_workflow_run_revisions
        TO omni_maintenance;
      GRANT SELECT, INSERT, UPDATE ON omni_customer_success_workflow_runs
        TO omni_maintenance;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
      GRANT SELECT ON omni_customer_success_workflow_run_revisions,
        omni_customer_success_workflow_runs TO omni_backup;
    END IF;
  END
  $migration$;

  DO $migration$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'omni_customer_success_workflow_run_revisions'::regclass
        AND tgname = 'omni_customer_success_workflow_run_revisions_immutable'
        AND NOT tgisinternal
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = 'omni_customer_success_workflow_runs'::regclass
        AND polname = 'omni_customer_success_workflow_runs_update_scope'
        AND NOT polpermissive
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = 'omni_customer_success_workflow_runs'::regclass
        AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'Customer-success workflow schema is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END
  $migration$;
`;
