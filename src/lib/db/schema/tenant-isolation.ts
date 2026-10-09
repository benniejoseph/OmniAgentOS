import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// ---------------------------------------------------------------------------
// RLS tenant isolation
// ---------------------------------------------------------------------------

export const tenantRootPolicyTables = [
  "omni_memories",
  "omni_memory_deletion_receipts",
  "omni_source_adapter_output_receipts",
  "omni_source_items",
  "omni_source_sync_page_checkpoints",
  "omni_tenant_capability_rollouts",
  "omni_tenant_memory_purpose_entitlements",
  "omni_tenant_actor_memory_purpose_consents",
  "omni_tenant_actor_memory_notice_receipts",
  "omni_personal_context_consents",
  "omni_tenant_actor_membership_epochs",
  "omni_tenant_actor_membership_management_authorities",
  "omni_membership_management_bootstrap_decisions",
  "omni_membership_management_bootstrap_attestations",
  "omni_tenant_execution_principals",
  "omni_tenant_workspaces",
  "omni_tenant_workspace_memberships",
  "omni_tenant_memory_access_grants",
  "omni_tenant_memory_operation_policies",
  "omni_tenant_memory_data_right_requests",
  "omni_knowledge_documents",
  "omni_knowledge_chunks",
  "omni_knowledge_cognition_candidates",
  "omni_retrieval_traces",
  "omni_agent_runs",
  "omni_run_checkpoints",
  "omni_run_checkpoint_state_references",
  "omni_run_checkpoint_resume_claims",
  "omni_run_forks",
  "omni_threads",
  "omni_tool_executions",
  "omni_plugin_install_previews",
  "omni_plugin_installations",
  "omni_plugin_mutation_receipts",
  "omni_mcp_connectors",
  "omni_mcp_tools",
  "omni_openapi_connectors",
  "omni_openapi_operations",
  "omni_workflow_runs",
  "omni_workflow_plans",
  "omni_eval_runs",
  "omni_eval_results",
  "omni_eval_reports",
  "omni_evaluation_failure_observations",
  "omni_evaluation_failure_clusters",
  "omni_harness_rule_proposals",
  "omni_security_audits",
  "omni_observability_events",
  "omni_observability_slo_policy_changes",
  "omni_trust_profiles",
  "omni_events",
  "omni_ai_usage",
  "omni_memory_graph_nodes",
  "omni_memory_graph_edges",
  "omni_memory_graph_builds",
  "omni_memory_graph_rebuild_queue",
  "omni_memory_reconciliation_reviews",
  "omni_memory_lifecycle_states",
  "omni_memory_promotion_reviews",
  "omni_conversation_summaries",
  "omni_conversation_summary_enrichments",
  "omni_market_macro_events",
  "omni_market_macro_event_events",
  "omni_market_macro_event_schedules",
  "omni_market_macro_event_schedule_events",
  "omni_market_macro_observations",
  "omni_market_macro_observation_events",
  "omni_market_price_snapshots",
  "omni_market_price_snapshot_events",
  "omni_market_event_replays",
  "omni_market_event_replay_events",
  "omni_market_backtests",
  "omni_market_backtest_events",
  "omni_entity_records",
  "omni_entity_aliases",
  "omni_entity_resolutions",
  "omni_entity_merge_reviews",
  "omni_entity_relation_claims",
  "omni_entity_relation_projection_queue",
  "omni_graph_query_telemetry",
  "omni_agent_memory_grants",
  "omni_agent_definition_versions",
  "omni_agent_principal_policies",
  "omni_agent_identity_backfill_holds",
  "omni_agent_release_channels",
  "omni_agent_release_evaluations",
  "omni_agent_adaptations",
  "omni_agent_learning_observations",
  "omni_agent_learning_cycles",
  "omni_delegation_tasks",
  "omni_delegation_budget_ledgers",
  "omni_delegation_executions",
  "omni_a2a_peer_rollouts",
  "omni_a2a_task_mappings",
  "omni_a2a_exchanges",
  "omni_a2a_safety_reservations",
  "omni_a2a_tool_call_claims",
  "omni_agent_loop_v2_checkpoints",
  "omni_prompt_queue_items",
  "omni_workflow_triggers",
  "omni_workflow_schedule_shadow_events",
  "omni_workflow_schedule_occurrences",
  "omni_workflow_schedule_occurrence_receipts",
  "omni_policy_leases",
  "omni_policy_lease_consumptions",
  "omni_operation_jobs",
  "omni_system_health_checks",
  "omni_incidents",
  "omni_alert_deliveries",
  "omni_observability_slo_policies",
  "omni_access_requests",
  "omni_auth_memberships",
  "omni_auth_sessions",
  "omni_mobile_sessions",
  "omni_mobile_push_registrations",
  "omni_mobile_push_deliveries",
  "omni_mobile_push_delivery_receipts",
  "omni_oauth_grants",
  "omni_today_items",
  "omni_today_preferences",
  "omni_daily_briefs",
  "omni_personal_notifications",
  "omni_projects",
  "omni_project_artifacts",
  "omni_app_builder_sessions",
  "omni_app_builder_checkpoints",
  "omni_app_builder_verifications",
  "omni_app_builder_repository_bindings",
  "omni_app_builder_deliveries",
  "omni_app_builder_deployments",
  "omni_app_builder_releases",
  "omni_app_builder_events",
  "omni_work_projects",
  "omni_work_project_memberships",
  "omni_work_items",
  "omni_work_item_status_history",
  "omni_work_compatibility_mappings",
  "omni_work_backfill_checkpoints",
  "omni_missions",
  "omni_mission_tasks",
  "omni_mission_attempts",
  "omni_mission_artifacts",
  "omni_custom_skills",
  "omni_custom_agents",
  "omni_moltbook_connections",
  "omni_moltbook_activities",
  "omni_moltbook_effect_receipts",
  "omni_capture_recordings",
  "omni_capture_segments",
  "omni_capture_assets",
  "omni_asset_objects",
  "omni_asset_object_migrations",
  "omni_generated_artifacts",
  "omni_generated_artifact_versions",
  "omni_generated_artifact_mutations",
  "omni_provider_connections",
  "omni_model_catalog",
  "omni_model_assignments",
  "omni_service_api_keys",
  "omni_mcp_export_configurations",
  "omni_trash_items",
  "omni_trash_effect_receipts",
  "omni_approval_grants",
  "omni_approval_grant_claims",
  "omni_browser_profiles",
  "omni_browser_profile_bindings",
  "omni_browser_takeovers",
  "omni_person_contact_policies",
  "omni_communication_intents",
  "omni_message_drafts",
  "omni_delivery_receipts",
  "omni_conversation_links",
  "omni_inbound_communications",
  "omni_ap2_signing_credentials",
  "omni_ap2_mandate_reviews",
  "omni_ap2_mandate_authorizations",
  "omni_ap2_credential_grants",
  "omni_ap2_credential_claims",
  "omni_ap2_payment_transactions",
  "omni_ap2_payment_receipts",
  "omni_ap2_reconciliation_observations",
  "omni_ap2_reconciliation_jobs",
  "omni_workspace_template_versions",
  "omni_workspace_template_channels",
  "omni_workspace_template_instantiations",
  "omni_meetings",
  "omni_meeting_revisions",
  "omni_capture_media_heads",
  "omni_capture_media_revisions",
  "omni_meeting_commitment_proposals",
  "omni_meeting_commitment_resolutions",
  "omni_customer_account_revisions",
  "omni_customer_accounts",
  "omni_customer_fact_revisions",
  "omni_salesforce_connections",
  "omni_salesforce_account_links",
  "omni_salesforce_record_revisions",
  "omni_salesforce_record_heads",
  "omni_salesforce_webhook_events",
  "omni_salesforce_reconciliation_findings",
  "omni_salesforce_write_operations",
  "omni_customer_health_policies",
  "omni_customer_health_score_revisions",
  "omni_customer_health_scores",
  "omni_customer_success_workflow_run_revisions",
  "omni_customer_success_workflow_runs",
] as const;

export const tenantChildPolicyTables = [
  "omni_source_revisions",
  "omni_source_tombstones",
  "omni_source_sync_heads",
  "omni_evidence_units",
  "omni_source_sync_page_items",
  "omni_agent_events",
  "omni_thread_turns",
  "omni_workflow_node_executions",
  "omni_workflow_trigger_events",
  "omni_workflow_steps",
  "omni_workflow_events",
  "omni_incident_events",
  "omni_project_tasks",
] as const;

export const tenantPolicyTables = [
  ...tenantRootPolicyTables,
  ...tenantChildPolicyTables,
] as const;

/**
 * Tenant tables whose SQL migrations create their own row security. The
 * isolation report checks them, but ensureTenantIsolationPolicies leaves them
 * alone: another permissive policy would admit rows their policies refuse.
 */
export const migrationScopedTenantTables = [
  "omni_google_personal_native_actions",
  "omni_native_connector_actions",
  "omni_native_connector_credential_preparations",
  "omni_native_mcp_registration_preparations",
  "omni_native_openapi_import_preparations",
  "omni_native_mcp_discoveries",
  "omni_native_github_upgrades",
  "omni_knowledge_native_cognition_builds",
  "omni_knowledge_native_cognition_effects",
  "omni_native_private_memory_actions",
  "omni_salesforce_native_actions",
  "omni_meeting_recording_processing_acceptances",
  "omni_meeting_recording_processing_effects",
  "omni_agent_skill_native_mutations",
  "omni_meeting_calendar_sync_acceptances",
  "omni_memory_lifecycle_mutations",
  "omni_meeting_commitment_resolution_intents",
  "omni_meeting_commitment_resolution_progress",
  "omni_responsibilities",
  "omni_responsibility_mutations",
  "omni_responsibility_observations",
  "omni_responsibility_baselines",
  "omni_responsibility_changes",
  "omni_responsibility_lifecycles",
  "omni_responsibility_wakes",
  "omni_responsibility_runtime_receipts",
  "omni_responsibility_budget_entries",
  "omni_responsibility_notification_admissions",
  "omni_responsibility_notification_candidates",
  "omni_responsibility_notification_receipts",
  "omni_companion_preferences",
  "omni_companion_preference_mutations",
  "omni_personal_profiles",
  "omni_personal_profile_mutations",
  "omni_local_computer_commands",
  "omni_local_computer_devices",
  "omni_local_computer_sessions",
  "omni_market_analysis_events",
  "omni_market_analysis_versions",
  "omni_market_forecast_events",
  "omni_market_forecast_outcomes",
  "omni_market_forward_forecasts",
  "omni_moltbook_authority_versions",
  "omni_moltbook_autonomy_action_claims",
  "omni_moltbook_autonomy_cycles",
  "omni_moltbook_autonomy_enrollments",
  "omni_moltbook_autonomy_events",
  "omni_moltbook_interest_observations",
  "omni_notification_digest_deliveries",
  "omni_notification_digest_watermarks",
  "omni_notification_dispositions",
] as const;

/**
 * Tables that hold no tenant's rows, each with the reason it has no tenant
 * policy. Every other table must be a tenant table, so a new one fails the
 * isolation checks until it is classified here or above.
 */
export const tenantIsolationExemptTables: Readonly<Record<string, string>> = {
  omni_schema_version: "The migration ledger.",
  omni_database_identity: "The database's own identity, one row.",
  omni_rate_limits: "Rate-limit windows under hashed keys.",
  omni_auth_tenants: "The tenant registry, read to resolve a session.",
  omni_auth_users: "Login identities, read before a tenant is known.",
  omni_auth_user_actor_identifiers:
    "Actor identifier aliases, readable only by the schema owner.",
  omni_memory_purpose_catalog:
    "Memory purpose contracts shared by every tenant, owner-only.",
  omni_memory_informed_notice_contracts:
    "Notice texts shared by every tenant, owner-only.",
  omni_memory_informed_notice_approval_batches:
    "Deployment notice approvals, owner-only.",
  omni_memory_informed_notice_approval_contracts:
    "Deployment notice approvals, owner-only.",
  omni_memory_informed_notice_review_attestations:
    "Deployment notice approvals, owner-only.",
  omni_observability_slo_approval_policies:
    "The deployment's one SLO approval policy.",
  omni_observability_slo_approval_policy_versions:
    "Versions of the deployment's one SLO approval policy.",
};


export async function ensureTenantIsolationPolicies(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_current_tenant()
    RETURNS TEXT
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT NULLIF(current_setting('omni.tenant_id', true), '')
    $$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_system_scope_enabled()
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT COALESCE(current_setting('omni.system_scope', true), '') = 'true'
        AND NULLIF(current_setting('omni.system_reason', true), '') IS NOT NULL
        AND current_user = (
          SELECT pg_get_userbyid(relowner)
          FROM pg_class
          WHERE oid = 'omni_schema_version'::regclass
        )
    $$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_tenant_visible(row_tenant TEXT)
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT omni_system_scope_enabled()
        OR (
          omni_current_tenant() IS NOT NULL
          AND row_tenant IS NOT NULL
          AND row_tenant = omni_current_tenant()
        )
    $$
  `;

  // Keep policy application inside one server-side block. Besides avoiding
  // hundreds of pooler round-trips during upgrades, this lets earlier
  // migrations safely skip tables that are only introduced by later ones.
  const policyTableArray = tenantPolicyTables
    .map((tableName) => `'${tableName.replaceAll("'", "''")}'`)
    .join(", ");
  await sql.query(`
    DO $migration$
    DECLARE
      policy_table TEXT;
      policy_schema TEXT := current_schema();
    BEGIN
      FOREACH policy_table IN ARRAY ARRAY[${policyTableArray}] LOOP
        IF to_regclass(format('%I.%I', policy_schema, policy_table)) IS NULL THEN
          CONTINUE;
        END IF;

        EXECUTE format(
          'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
          policy_schema,
          policy_table
        );
        EXECUTE format(
          'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
          policy_schema,
          policy_table
        );

        IF EXISTS (
          SELECT 1
          FROM pg_policy policy
          JOIN pg_class relation ON relation.oid = policy.polrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = policy_schema
            AND relation.relname = policy_table
            AND policy.polname = 'omni_tenant_isolation'
        ) THEN
          EXECUTE format(
            'ALTER POLICY omni_tenant_isolation ON %I.%I ' ||
            'USING (omni_tenant_visible(tenant_id)) ' ||
            'WITH CHECK (omni_tenant_visible(tenant_id))',
            policy_schema,
            policy_table
          );
        ELSE
          EXECUTE format(
            'CREATE POLICY omni_tenant_isolation ON %I.%I FOR ALL ' ||
            'USING (omni_tenant_visible(tenant_id)) ' ||
            'WITH CHECK (omni_tenant_visible(tenant_id))',
            policy_schema,
            policy_table
          );
        END IF;
      END LOOP;
    END
    $migration$
  `);
}
