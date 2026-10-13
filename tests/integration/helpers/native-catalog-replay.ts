import type postgres from "postgres";
import { expect } from "vitest";
import { databaseSchemaMigrations, getSchemaMigrationSteps } from "@/lib/db/client";
import { ensureAgentAdaptationLifecycleV1 } from "@/lib/db/schema/agents";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import type { SqlClient } from "@/lib/db/sql-types";

/** Only disposable migration fixtures may remove empty comparison evidence.
 * Capture the original trigger declaration without rerunning its old RLS or ACLs. */
export async function removeEmptyAgentTextComparisonsForReplay(sql: postgres.TransactionSql) {
  // Remove the later read-only fence before restoring its exact predecessor.
  // The function owns no data; historical fixtures must still replay its ACLs.
  await sql`DROP FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT)`;
  await sql`DELETE FROM omni_schema_version WHERE version=254`;
  expect(await sql`SELECT
    (SELECT count(*)::int FROM public.omni_agent_adaptation_comparisons) AS comparisons,
    (SELECT count(*)::int FROM public.omni_agent_adaptations WHERE comparison IS NOT NULL) AS measured
  `).toEqual([{ comparisons: 0, measured: 0 }]);
  const declarations: string[] = [];
  const capture = Object.assign(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    expect(params).toHaveLength(0);
    const statement = strings.join("");
    if (statement.trimStart().startsWith("CREATE OR REPLACE FUNCTION omni_protect_agent_adaptation_v1()")) declarations.push(statement);
    return [];
  }, {
    query: async () => [], unsafe: async () => [], transaction: async () => undefined,
    transactionScoped: true,
  }) satisfies SqlClient;
  await ensureAgentAdaptationLifecycleV1(capture);
  expect(declarations).toHaveLength(1);
  await sql.unsafe(declarations[0]);
  await sql`DROP TABLE public.omni_agent_adaptation_comparisons`;
  await sql`DROP FUNCTION public.omni_protect_adaptation_comparison_v1()`;
  await sql`ALTER TABLE public.omni_agent_adaptations DROP COLUMN comparison`;
  await sql`DELETE FROM omni_schema_version WHERE version=253`;
}

async function readReplayMigration(version: number, file: string) {
  const row = databaseSchemaMigrations.find((migration) => migration.version === version);
  if (!row) throw new Error(`Replay migration ${version} is missing.`);
  const step = getSchemaMigrationSteps().find((candidate) =>
    candidate.kind === "sql" && candidate.file === file && candidate.migrations.some((migration) => migration.version === version));
  if (!step || step.kind !== "sql") throw new Error(`Replay migration ${version} has no exact SQL file.`);
  // Older ledger checksums predate file digests. Validate the actual manifest
  // sha256 and every version recorded by the file, exactly as the runner does.
  return { row, migration: await readSqlMigrationFile(step) };
}

/** Restore the exact 251 boundary on an empty, disposable personal-partner lane. */
export async function removeEmptyPersonalPartnerMigrationsForReplay(sql: postgres.TransactionSql) {
  await removeEmptyAgentTextComparisonsForReplay(sql);
  expect(await sql`SELECT
    (SELECT count(*)::int FROM public.omni_responsibility_lifecycles WHERE snapshot->'configuration'->'source'->>'kind'='work_item') AS work_items,
    (SELECT count(*)::int FROM public.omni_responsibility_notification_admissions WHERE snapshot->'configuration'->'source'->>'kind'='work_item') AS admissions
  `).toEqual([{ work_items: 0, admissions: 0 }]);
  for (const [version, file, name] of [
    [218, "20261004110000_responsibility_runtime.sql", "omni_protect_responsibility_runtime_head_v1"],
    [219, "20261004113000_responsibility_notifications.sql", "omni_protect_responsibility_notification_head_v1"],
  ] as const) {
    const { migration } = await readReplayMigration(version, file);
    const statements = migration.statements.filter((statement) => statement.trimStart().startsWith(`CREATE FUNCTION public.${name}()`));
    expect(statements).toHaveLength(1);
    await sql.unsafe(statements[0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
  }
  await sql`DELETE FROM omni_schema_version WHERE version=252`;
}

/** Disposable historical fixtures must remove the real 246–251 additions before
 * replaying their unchanged SQL. Reject feature evidence instead of discarding it. */
export async function removeEmptyPost245MigrationsForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT
    (SELECT count(*)::int FROM public.omni_listen_grants) AS listen_grants,
    (SELECT count(*)::int FROM public.omni_listen_sources) AS listen_sources,
    (SELECT count(*)::int FROM public.omni_capture_segments WHERE media_transcript->'noSpeech'='true'::jsonb) AS silent_segments,
    (SELECT count(*)::int FROM public.omni_personal_profiles) AS profiles,
    (SELECT count(*)::int FROM public.omni_personal_profile_mutations) AS profile_mutations,
    (SELECT count(*)::int FROM public.omni_local_computer_devices WHERE platform='android') AS android_devices,
    (SELECT count(*)::int FROM public.omni_prompt_queue_items WHERE target->>'executionTarget'='local_android') AS android_prompts,
    (SELECT count(*)::int FROM public.omni_local_computer_commands WHERE action IN ('open_app','tap','swipe','back','home')) AS android_commands,
    (SELECT count(*)::int FROM public.omni_thread_turns WHERE workflow_run_id IS NOT NULL) AS workflow_turns,
    (SELECT count(*)::int FROM public.omni_mobile_push_deliveries WHERE cause_kind='research') AS research_pushes,
    (SELECT count(*)::int FROM public.omni_notification_dispositions WHERE source_kind='research_workflow' OR reason='research_ready') AS research_dispositions
  `).toEqual([{
    listen_grants: 0, listen_sources: 0, silent_segments: 0, profiles: 0,
    profile_mutations: 0, android_devices: 0, android_prompts: 0,
    android_commands: 0, workflow_turns: 0, research_pushes: 0, research_dispositions: 0,
  }]);

  // Version 251 broadens only these restrictive media-owner policies.
  for (const table of ["omni_capture_media_heads", "omni_capture_media_revisions"]) {
    await sql.unsafe(`ALTER POLICY ${table}_actor_scope ON public.${table}
      USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))
      WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id))`);
  }
  await sql`DROP FUNCTION public.omni_listen_media_owner_v1(TEXT,TEXT,TEXT,BOOLEAN)`;
  await sql`DROP TRIGGER omni_listen_recording_deleted ON public.omni_capture_recordings`;
  await sql`DROP TRIGGER omni_listen_no_speech_checkpoint ON public.omni_capture_segments`;
  await sql`DROP FUNCTION public.omni_listen_recording_deleted_v1()`;
  await sql`DROP FUNCTION public.omni_listen_no_speech_checkpoint_v1()`;
  await sql`DROP FUNCTION public.omni_retire_listen_memories_v1(TEXT,TEXT,TEXT[],TIMESTAMPTZ)`;
  await sql`DROP TABLE public.omni_listen_sources, public.omni_listen_grants`;
  await sql`ALTER TABLE public.omni_capture_segments DROP CONSTRAINT omni_capture_segments_media_transcript_check`;
  const media = await readReplayMigration(135, "20260908004500_p10_7_resumable_media_processing.sql");
  const mediaChecks = media.migration.statements.filter((statement) =>
    /^ALTER TABLE omni_capture_segments\s+ADD CONSTRAINT omni_capture_segments_media_transcript_check/.test(statement));
  expect(mediaChecks).toHaveLength(1);
  // The same historical statement also adds the unchanged raw-audio check.
  expect(mediaChecks[0]).toContain("ADD CONSTRAINT omni_capture_segments_raw_audio_check");
  await sql.unsafe(mediaChecks[0].replace(/,\s+ADD CONSTRAINT omni_capture_segments_raw_audio_check[\s\S]*$/, ""));

  await sql`DROP TRIGGER omni_local_computer_platform_action ON public.omni_local_computer_commands`;
  await sql`DROP FUNCTION public.omni_local_computer_platform_action_v1()`;
  await sql`ALTER TABLE public.omni_local_computer_devices DROP CONSTRAINT omni_local_computer_devices_row_check`;
  const devices = await readReplayMigration(179, "20260917110000_p13_3_local_computer_runtime.sql");
  const deviceTables = devices.migration.statements.filter((statement) =>
    statement.startsWith("CREATE TABLE public.omni_local_computer_devices ("));
  expect(deviceTables).toHaveLength(1);
  const deviceConstraint = deviceTables[0].match(/CONSTRAINT omni_local_computer_devices_row_check CHECK \([\s\S]*\)\s*\)/)?.[0];
  expect(deviceConstraint).toBeDefined();
  if (!deviceConstraint) throw new Error("The historical device constraint is missing.");
  await sql.unsafe(`ALTER TABLE public.omni_local_computer_devices ADD ${deviceConstraint.replace(/\)\s*$/, "")}`);
  await sql`ALTER TABLE public.omni_local_computer_commands DROP CONSTRAINT omni_local_computer_commands_row_check`;
  const commands = await readReplayMigration(205, "20260924110000_governed_local_command_runner.sql");
  const commandChecks = commands.migration.statements.filter((statement) =>
    /^ALTER TABLE public.omni_local_computer_commands\s+(ADD CONSTRAINT|VALIDATE CONSTRAINT) omni_local_computer_commands_row_check/.test(statement));
  expect(commandChecks).toHaveLength(2);
  for (const statement of commandChecks) await sql.unsafe(statement);
  await sql`ALTER TABLE public.omni_prompt_queue_items
    DROP CONSTRAINT omni_prompt_queue_items_execution_target_v53,
    ADD CHECK (target->>'executionTarget' IN ('asael','local_macos'))`;

  await sql`DROP TABLE public.omni_personal_profile_mutations, public.omni_personal_profiles`;
  await sql`DROP FUNCTION public.omni_personal_profile_revision_v1()`;
  await sql`DROP FUNCTION public.omni_thread_workflow_canonical_actor_v1(TEXT,TEXT)`;
  await sql`ALTER TABLE public.omni_thread_turns DROP COLUMN workflow_run_id`;
  await sql`ALTER TABLE public.omni_workflow_runs DROP CONSTRAINT omni_workflow_runs_tenant_id_key`;
  await sql`DROP INDEX public.omni_workflow_runs_research_notification_idx`;
  await sql`ALTER TABLE public.omni_mobile_push_deliveries DROP CONSTRAINT omni_mobile_push_deliveries_cause_kind_check_v4`;
  const dispositions = await readReplayMigration(200, "20260922163000_notification_disposition_runtime.sql");
  const pushChecks = dispositions.migration.statements.filter((statement) =>
    /^ALTER TABLE public.omni_mobile_push_deliveries\s+(ADD CONSTRAINT|VALIDATE CONSTRAINT) omni_mobile_push_deliveries_cause_kind_check_v3/.test(statement));
  expect(pushChecks).toHaveLength(2);
  for (const statement of pushChecks) await sql.unsafe(statement);
  await sql`ALTER TABLE public.omni_notification_dispositions
    DROP CONSTRAINT omni_notification_dispositions_research_policy,
    DROP CONSTRAINT omni_notification_dispositions_source_kind_check,
    DROP CONSTRAINT omni_notification_dispositions_reason_check`;
  const notifications = await readReplayMigration(219, "20261004113000_responsibility_notifications.sql");
  const notificationChecks = notifications.migration.statements.filter((statement) =>
    /^ALTER TABLE public.omni_notification_dispositions ADD CONSTRAINT omni_notification_dispositions_(source_kind|reason)_check/.test(statement));
  expect(notificationChecks).toHaveLength(2);
  for (const statement of notificationChecks) await sql.unsafe(statement);
  await sql`DELETE FROM omni_schema_version WHERE version BETWEEN 246 AND 251`;
}

/** Reinstall every additive release after a historical connector replay has reached 245. */
export async function replayPost245Migrations(sql: postgres.TransactionSql) {
  const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: async (statement, params) => {
    const values = (params ?? []).map((value) => {
      if (typeof value !== "string") throw new Error("Migration settings must be strings.");
      return value;
    });
    return sql.unsafe<Record<string, unknown>[]>(statement, values);
  } };
  for (const [version, file] of [
    [246, "20261008100000_research_workflow_notifications.sql"],
    [247, "20261008110000_thread_turn_workflow_run_binding.sql"],
    [248, "20261009203000_personal_profiles.sql"],
    [249, "20261010120000_android_local_control.sql"],
    [250, "20261010180000_listen_capture.sql"],
    [251, "20261012123000_listen_media_owner_scope.sql"],
    [252, "20261013090000_responsibility_work_item_followthrough.sql"],
    [253, "20261013093000_agent_text_comparisons.sql"],
    [254, "20261013150000_responsibility_workspace_read_fence.sql"],
  ] as const) {
    const { row, migration } = await readReplayMigration(version, file);
    await applySqlMigrationFile(adapter, migration, [row], []);
  }
}


/** Restore243 only when this disposable fixture has no GitHub upgrade evidence. */
export async function removeNativeGithubUpgradesForReplay(sql: postgres.TransactionSql) {
  expect(await sql`SELECT count(*)::int AS upgrades FROM public.omni_native_github_upgrades`).toEqual([{ upgrades: 0 }]);
  await sql`DROP TRIGGER omni_native_00_provider_singleflight ON public.omni_native_mcp_discoveries`;
  await sql`DROP TABLE public.omni_native_github_upgrades`;
  await sql`DROP FUNCTION public.omni_native_provider_singleflight_v1()`;
  await sql`DROP FUNCTION public.omni_native_provider_pending_v1(TEXT,TEXT,TEXT,TEXT)`;
  await sql`DROP FUNCTION public.omni_protect_native_github_upgrade_v1()`;
  await sql`DROP FUNCTION public.omni_native_github_upgrade_closure_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_github_upgrade_settlement_valid_v1(JSONB,JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_github_upgrade_attempt_valid_v1(JSONB,JSONB)`;
  await sql`DROP FUNCTION public.omni_native_github_upgrade_intent_valid_v1(JSONB)`;
}

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
