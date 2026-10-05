import type postgres from "postgres";
import { expect } from "vitest";

/** Restore242 only when this disposable fixture has no discovery evidence. */
export async function removeNativeMcpDiscoveriesForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS discoveries FROM public.omni_native_mcp_discoveries`).toEqual([{ discoveries: 0 }]);
  await sql`DROP TABLE public.omni_native_mcp_discoveries`;
  await sql`DROP FUNCTION public.omni_protect_native_mcp_discovery_v1()`;
  await sql`DROP FUNCTION public.omni_native_mcp_discovery_closure_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_mcp_discovery_settlement_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_mcp_discovery_attempt_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_mcp_discovery_intent_valid_v1(JSONB)`;
}

/** Restore241 only when this disposable fixture has no OpenAPI import evidence. */
export async function removeNativeOpenapiImportsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT (SELECT count(*)::int FROM public.omni_native_openapi_import_preparations) AS preparations,
    (SELECT count(*)::int FROM public.omni_native_connector_actions WHERE action='import_openapi') AS imports`).toEqual([{ preparations: 0, imports: 0 }]);
  await sql`DROP TRIGGER omni_native_openapi_import_action_guard ON public.omni_native_connector_actions`;
  await sql`DROP FUNCTION public.omni_protect_native_openapi_import_action_v1()`;
  await sql`ALTER TABLE public.omni_native_connector_actions
    DROP CONSTRAINT omni_native_connector_intent_v6,
    DROP CONSTRAINT omni_native_connector_settlement_v6,
    DROP CONSTRAINT omni_native_connector_actions_action_check,
    ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash','rotate_mcp','register_mcp')),
    ADD CONSTRAINT omni_native_connector_intent_v5 CHECK(public.omni_native_connector_intent_valid_v5(intent,acceptance)),
    ADD CONSTRAINT omni_native_connector_settlement_v5 CHECK(public.omni_native_connector_settlement_valid_v5(settlement,acceptance))`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v6(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v6(JSONB,JSONB)`;
  await sql`DROP TABLE public.omni_native_openapi_import_preparations`;
  await sql`DROP FUNCTION public.omni_protect_native_openapi_import_preparation_v1()`;
  await sql`DROP FUNCTION public.omni_native_openapi_import_abandonment_valid_v1(JSONB,JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_openapi_import_preparation_proof_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_openapi_import_attempt_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_openapi_import_preparation_intent_valid_v1(JSONB)`;
  await sql`DROP FUNCTION public.omni_native_openapi_import_declaration_valid_v1(JSONB,BOOLEAN)`;
}

/** Restore240 only when this disposable fixture has no registration evidence. */
export async function removeNativeMcpRegistrationsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT (SELECT count(*)::int FROM public.omni_native_mcp_registration_preparations) AS preparations,
    (SELECT count(*)::int FROM public.omni_native_connector_actions WHERE action='register_mcp') AS registrations`).toEqual([{ preparations: 0, registrations: 0 }]);
  await sql`DROP TRIGGER omni_native_mcp_registration_action_guard ON public.omni_native_connector_actions`;
  await sql`DROP FUNCTION public.omni_protect_native_mcp_registration_action_v1()`;
  await sql`DROP TABLE public.omni_native_mcp_registration_preparations`;
  await sql`DROP FUNCTION public.omni_protect_native_mcp_registration_preparation_v1()`;
  await sql`DROP FUNCTION public.omni_native_mcp_registration_abandonment_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_mcp_registration_preparation_proof_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_mcp_registration_preparation_intent_valid_v1(JSONB)`;
  await sql`ALTER TABLE public.omni_native_connector_actions
    DROP CONSTRAINT omni_native_connector_intent_v5,
    DROP CONSTRAINT omni_native_connector_settlement_v5,
    DROP CONSTRAINT omni_native_connector_actions_action_check,
    ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash','rotate_mcp')),
    ADD CONSTRAINT omni_native_connector_intent_v4 CHECK(public.omni_native_connector_intent_valid_v4(intent,acceptance)),
    ADD CONSTRAINT omni_native_connector_settlement_v4 CHECK(public.omni_native_connector_settlement_valid_v4(settlement,acceptance))`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v5(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v5(JSONB,JSONB)`;
}

/** Restore239 only when this disposable fixture has no preparation/rotation evidence. */
export async function removeNativeConnectorCredentialRotationsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT (SELECT count(*)::int FROM public.omni_native_connector_credential_preparations) AS preparations,
    (SELECT count(*)::int FROM public.omni_native_connector_actions WHERE action='rotate_mcp') AS rotations`).toEqual([{ preparations: 0, rotations: 0 }]);
  await sql`DROP TABLE public.omni_native_connector_credential_preparations`;
  await sql`DROP FUNCTION public.omni_protect_native_credential_preparation_v1()`;
  await sql`DROP FUNCTION public.omni_native_credential_abandonment_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_credential_preparation_proof_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_credential_preparation_intent_valid_v1(JSONB)`;
  await sql`ALTER TABLE public.omni_native_connector_actions
    DROP CONSTRAINT omni_native_connector_intent_v4,
    DROP CONSTRAINT omni_native_connector_settlement_v4,
    DROP CONSTRAINT omni_native_connector_rotation_version,
    DROP CONSTRAINT omni_native_connector_actions_action_check,
    ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential','trash')),
    ADD CONSTRAINT omni_native_connector_intent_v3 CHECK(public.omni_native_connector_intent_valid_v3(intent,acceptance)),
    ADD CONSTRAINT omni_native_connector_settlement_v3 CHECK(public.omni_native_connector_settlement_valid_v3(settlement,acceptance))`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v4(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v4(JSONB,JSONB)`;
}

/** Restore238 without altering historical state/removal evidence on a disposable DB. */
export async function removeNativeConnectorTrashForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS moves FROM public.omni_native_connector_actions WHERE action='trash'`).toEqual([{ moves: 0 }]);
  await sql`ALTER TABLE public.omni_native_connector_actions
    DROP CONSTRAINT omni_native_connector_intent_v3,
    DROP CONSTRAINT omni_native_connector_settlement_v3,
    DROP CONSTRAINT omni_native_connector_actions_action_check,
    ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable','remove_credential')),
    ADD CONSTRAINT omni_native_connector_intent_v2 CHECK(public.omni_native_connector_intent_valid_v2(intent,acceptance)),
    ADD CONSTRAINT omni_native_connector_settlement_v2 CHECK(public.omni_native_connector_settlement_valid_v2(settlement,acceptance))`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v3(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v3(JSONB,JSONB)`;
}

/** Restore the exact237 validation boundary before replaying238 on a disposable DB. */
export async function removeNativeConnectorCredentialRemovalsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS removals FROM public.omni_native_connector_actions WHERE action='remove_credential'`).toEqual([{ removals: 0 }]);
  await sql`ALTER TABLE public.omni_native_connector_actions
    DROP CONSTRAINT omni_native_connector_intent_v2,
    DROP CONSTRAINT omni_native_connector_settlement_v2,
    DROP CONSTRAINT omni_native_connector_removal_version,
    DROP CONSTRAINT omni_native_connector_actions_action_check,
    ADD CONSTRAINT omni_native_connector_actions_action_check CHECK(action IN ('review_contracts','enable','disable')),
    ADD CONSTRAINT omni_native_connector_actions_check CHECK(public.omni_native_connector_intent_valid_v1(intent,acceptance)),
    ADD CONSTRAINT omni_native_connector_actions_check3 CHECK(public.omni_native_connector_settlement_valid_v1(settlement,acceptance))`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v2(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v2(JSONB,JSONB)`;
}

export async function removeEmptyNativeConnectorControlsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS acceptances FROM public.omni_native_connector_actions`).toEqual([{ acceptances: 0 }]);
  await sql`DROP POLICY omni_native_connector_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_native_connector_actions`;
  await sql`DROP FUNCTION public.omni_protect_native_connector_action_v1()`;
  await sql`DROP FUNCTION public.omni_native_connector_settlement_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_intent_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_connector_actor_v1(TEXT,TEXT,TEXT,BOOLEAN)`;
}

export async function removeEmptyGooglePersonalNativeActionsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS acceptances FROM public.omni_google_personal_native_actions`).toEqual([{ acceptances: 0 }]);
  await sql`DROP POLICY omni_google_personal_native_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_google_personal_native_actions`;
  await sql`DROP FUNCTION public.omni_protect_google_personal_native_action_v1()`;
  await sql`DROP FUNCTION public.omni_google_personal_sync_allowed_v1(TEXT,TEXT)`;
  await sql`DROP FUNCTION public.omni_google_personal_settlement_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_google_personal_review_valid_v1(JSONB)`;
}

export async function removeEmptyNativeKnowledgeCognitionBuildsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT (SELECT count(*)::int FROM public.omni_knowledge_native_cognition_builds) AS builds,
    (SELECT count(*)::int FROM public.omni_knowledge_native_cognition_effects) AS effects`).toEqual([{ builds: 0, effects: 0 }]);
  await sql`DROP POLICY omni_native_cognition_build_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_knowledge_native_cognition_effects`;
  await sql`DROP TABLE public.omni_knowledge_native_cognition_builds`;
  await sql`DROP FUNCTION public.omni_protect_native_cognition_effect_v1()`;
  await sql`DROP FUNCTION public.omni_protect_native_cognition_build_v1()`;
  await sql`DROP FUNCTION public.omni_native_cognition_build_valid_v1(JSONB,JSONB,JSONB)`;
}

export async function removeEmptyNativePrivateMemoryActionsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS acceptances FROM public.omni_native_private_memory_actions`).toEqual([{ acceptances: 0 }]);
  await sql`DROP TRIGGER omni_memory_lifecycle_graph_statement_lock ON public.omni_memory_lifecycle_states`;
  await sql`DROP TRIGGER omni_retrieval_traces_delete_graph_statement_lock ON public.omni_retrieval_traces`;
  await sql`DROP POLICY omni_native_private_memory_event_actor ON public.omni_events`;
  await sql`DROP TRIGGER omni_native_private_memory_forget ON public.omni_memories`;
  await sql`DROP TABLE public.omni_native_private_memory_actions`;
  await sql`DROP FUNCTION public.omni_native_private_memory_forget_v1()`;
  await sql`DROP FUNCTION public.omni_native_private_memory_immutable_v1()`;
  await sql`DROP FUNCTION public.omni_native_private_memory_action_valid_v1(TEXT,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_private_memory_action_valid_233_v1(TEXT,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_knowledge_deletion_lineage_v1(TEXT,TEXT,TEXT,TEXT,TEXT[],BOOLEAN,TIMESTAMPTZ)`;
  await sql`DROP FUNCTION public.omni_native_private_memory_owner_v1(TEXT,TEXT,TEXT,BOOLEAN)`;
}

export async function removeEmptySalesforceNativeActionsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS acceptances FROM public.omni_salesforce_native_actions`).toEqual([{ acceptances: 0 }]);
  await sql`DROP POLICY omni_salesforce_native_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_salesforce_native_actions`;
  await sql`DROP FUNCTION public.omni_protect_salesforce_native_action_v1()`;
}

/** Only empty disposable fixtures may recreate these actual predecessor schemas. */
export async function removeEmptyCustomerWorkflowIntentsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS intents FROM public.omni_customer_success_workflow_run_revisions
    WHERE native_intent IS NOT NULL OR native_intent_sha256 IS NOT NULL`).toEqual([{ intents: 0 }]);
  await sql`DROP TRIGGER omni_customer_workflow_native_intent_validate ON public.omni_customer_success_workflow_run_revisions`;
  await sql`DROP FUNCTION public.omni_validate_customer_workflow_native_intent_v1()`;
  await sql`ALTER TABLE public.omni_customer_success_workflow_run_revisions
    DROP CONSTRAINT omni_customer_workflow_exact_native_intent, DROP COLUMN native_intent, DROP COLUMN native_intent_sha256`;
}

export async function removeEmptyAgentSkillMutationsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS acceptances FROM public.omni_agent_skill_native_mutations`).toEqual([{ acceptances: 0 }]);
  await sql`DROP POLICY omni_agent_skill_native_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_agent_skill_native_mutations`;
  await sql`DROP FUNCTION public.omni_agent_skill_native_immutable_v1()`;
  await sql`DROP TRIGGER aa_omni_moltbook_agent_parent_lock ON public.omni_moltbook_connections`;
  await sql`DROP FUNCTION public.omni_lock_moltbook_agent_parent_v1()`;
  await sql`DO $restore$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_runtime') THEN
      REVOKE EXECUTE ON FUNCTION public.omni_agent_persona_v1_is_valid(JSONB) FROM omni_runtime;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='omni_maintenance') THEN
      REVOKE EXECUTE ON FUNCTION public.omni_agent_persona_v1_is_valid(JSONB) FROM omni_maintenance;
    END IF;
  END $restore$`;
}

export async function removeEmptyMeetingRecordingProcessingForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT (SELECT count(*)::int FROM public.omni_meeting_recording_processing_acceptances) AS acceptances,
    (SELECT count(*)::int FROM public.omni_meeting_recording_processing_effects) AS effects`).toEqual([{ acceptances: 0, effects: 0 }]);
  await sql`DROP POLICY omni_native_recording_event_actor ON public.omni_events`;
  await sql`DROP TABLE public.omni_meeting_recording_processing_effects`;
  await sql`DROP TABLE public.omni_meeting_recording_processing_acceptances`;
  await sql`DROP FUNCTION public.omni_protect_native_recording_effect_v1()`;
  await sql`DROP FUNCTION public.omni_protect_native_recording_acceptance_v1()`;
}

export async function removeEmptyCustomerFactIntentsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS intents FROM public.omni_customer_fact_revisions
    WHERE native_intent IS NOT NULL OR native_intent_sha256 IS NOT NULL`).toEqual([{ intents: 0 }]);
  await sql`DROP TRIGGER omni_customer_fact_native_intent_validate ON public.omni_customer_fact_revisions`;
  await sql`DROP FUNCTION public.omni_validate_customer_fact_native_intent_v1()`;
  await sql`DROP INDEX public.omni_customer_fact_native_key`;
  await sql`ALTER TABLE public.omni_customer_fact_revisions DROP CONSTRAINT omni_customer_fact_native_intent,
    DROP COLUMN native_intent, DROP COLUMN native_intent_sha256`;
}
