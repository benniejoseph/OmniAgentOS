import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for personal work: today items, daily briefs,
// notifications, projects, artifacts, captures and the mission kernel.

export async function ensureTodayItems(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_today_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      due_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_today_items_tenant_actor_status_idx ON omni_today_items (tenant_id, actor_id, status, due_at, created_at DESC)`;
}

export async function ensureProactiveDailyBriefs(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_today_preferences (
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      brief_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      brief_time TEXT NOT NULL DEFAULT '08:00',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      reminder_lead_minutes INTEGER NOT NULL DEFAULT 30,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, actor_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_today_preferences_schedule_idx ON omni_today_preferences (tenant_id, brief_enabled, updated_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_daily_briefs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '{}',
      generated_by TEXT NOT NULL DEFAULT 'system',
      model TEXT,
      source_counts JSONB NOT NULL DEFAULT '{}',
      memory_ids TEXT[] NOT NULL DEFAULT '{}',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, local_date)
    )
  `;
  await sql`ALTER TABLE omni_daily_briefs ADD COLUMN IF NOT EXISTS memory_ids TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`
    UPDATE omni_daily_briefs
    SET content = jsonb_set(content, '{memoryIds}', to_jsonb(memory_ids), TRUE)
    WHERE jsonb_typeof(content) = 'object'
      AND NOT content ? 'memoryIds'
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_daily_briefs_tenant_actor_date_idx ON omni_daily_briefs (tenant_id, actor_id, local_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_daily_briefs_memory_ids_idx ON omni_daily_briefs USING GIN (memory_ids)`;
}

export async function ensureCaptureStructuredExtractionV1(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_capture_assets
    ADD COLUMN IF NOT EXISTS extraction_receipt JSONB
  `;
  await sql`
    ALTER TABLE omni_asset_objects
    DROP CONSTRAINT IF EXISTS omni_asset_objects_extraction_check
  `;
  await sql`
    ALTER TABLE omni_asset_objects
    ADD CONSTRAINT omni_asset_objects_extraction_check CHECK (
      extraction_state IN ('pending', 'completed', 'partial', 'unsupported', 'failed')
    ) NOT VALID
  `;
  await sql`
    ALTER TABLE omni_asset_objects
    VALIDATE CONSTRAINT omni_asset_objects_extraction_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_capture_assets'::regclass
          AND conname = 'omni_capture_assets_extraction_status_check'
      ) THEN
        ALTER TABLE omni_capture_assets
        ADD CONSTRAINT omni_capture_assets_extraction_status_check CHECK (
          extraction_status IN (
            'pending', 'completed', 'partial', 'unsupported', 'failed'
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_capture_assets
    VALIDATE CONSTRAINT omni_capture_assets_extraction_status_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_capture_assets'::regclass
          AND conname = 'omni_capture_assets_extraction_receipt_check'
      ) THEN
        ALTER TABLE omni_capture_assets
        ADD CONSTRAINT omni_capture_assets_extraction_receipt_check CHECK (
          extraction_receipt IS NULL
          OR COALESCE(
            jsonb_typeof(extraction_receipt) = 'object'
            AND extraction_receipt ->> 'schemaVersion' = '1'
            AND extraction_receipt ->> 'state' = extraction_status
            AND extraction_receipt ->> 'sourceKind' IN (
              'document', 'spreadsheet', 'presentation', 'email',
              'calendar_event', 'message', 'webpage', 'image', 'audio',
              'video', 'record', 'file', 'capture'
            )
            AND extraction_receipt ->> 'extractorId' =
              'asael.capture.structured'
            AND extraction_receipt ->> 'extractorVersionId' = '1'
            AND extraction_receipt ->> 'extractorConfigSha256'
              ~ '^[a-f0-9]{64}$'
            AND extraction_receipt ->> 'receiptSha256'
              ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(extraction_receipt -> 'warningCodes') = 'array'
            AND jsonb_typeof(extraction_receipt -> 'locatorKinds') = 'array'
            AND CASE
              WHEN extraction_receipt ->> 'unitCount'
                ~ '^(0|[1-9][0-9]{0,3})$'
              THEN (extraction_receipt ->> 'unitCount')::integer
                BETWEEN 0 AND 1024
              ELSE FALSE
            END
            AND CASE
              WHEN extraction_receipt ->> 'state' IN ('completed', 'partial')
              THEN CASE
                  WHEN extraction_receipt ->> 'unitCount'
                    ~ '^[1-9][0-9]{0,3}$'
                  THEN (extraction_receipt ->> 'unitCount')::integer
                    BETWEEN 1 AND 1024
                  ELSE FALSE
                END
                AND extraction_receipt ->> 'contentSha256'
                  ~ '^[a-f0-9]{64}$'
                AND CASE
                  WHEN jsonb_typeof(extraction_receipt -> 'locatorKinds') = 'array'
                  THEN jsonb_array_length(extraction_receipt -> 'locatorKinds') > 0
                  ELSE FALSE
                END
              ELSE extraction_receipt ->> 'state' IN ('unsupported', 'failed')
                AND extraction_receipt ->> 'unitCount' = '0'
                AND extraction_receipt -> 'contentSha256' = 'null'::jsonb
                AND CASE
                  WHEN jsonb_typeof(extraction_receipt -> 'locatorKinds') = 'array'
                  THEN jsonb_array_length(extraction_receipt -> 'locatorKinds') = 0
                  ELSE FALSE
                END
            END,
            FALSE
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_capture_assets
    VALIDATE CONSTRAINT omni_capture_assets_extraction_receipt_check
  `;
  await sql`
    DO $migration$
    DECLARE
      object_constraint TEXT;
      asset_status_constraint TEXT;
      asset_receipt_constraint TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO object_constraint
      FROM pg_constraint
      WHERE conrelid = 'omni_asset_objects'::regclass
        AND conname = 'omni_asset_objects_extraction_check'
        AND convalidated;
      SELECT pg_get_constraintdef(oid) INTO asset_status_constraint
      FROM pg_constraint
      WHERE conrelid = 'omni_capture_assets'::regclass
        AND conname = 'omni_capture_assets_extraction_status_check'
        AND convalidated;
      SELECT pg_get_constraintdef(oid) INTO asset_receipt_constraint
      FROM pg_constraint
      WHERE conrelid = 'omni_capture_assets'::regclass
        AND conname = 'omni_capture_assets_extraction_receipt_check'
        AND convalidated;
      IF object_constraint NOT LIKE '%partial%'
        OR asset_status_constraint NOT LIKE '%partial%'
        OR asset_receipt_constraint NOT LIKE '%receiptSha256%'
        OR asset_receipt_constraint NOT LIKE '%asael.capture.structured%'
      THEN
        RAISE EXCEPTION 'Capture structured extraction boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensurePersonalNotificationCenter(sql: SqlClient) {
  await ensureProactiveDailyBriefs(sql);
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT NOT NULL DEFAULT '22:00'`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT NOT NULL DEFAULT '07:00'`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_personal_notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'reminder',
      source_type TEXT NOT NULL DEFAULT 'today_item',
      source_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      due_at TIMESTAMPTZ NOT NULL,
      snoozed_until TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, source_type, source_id, occurrence_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_personal_notifications_inbox_idx ON omni_personal_notifications (tenant_id, actor_id, status, updated_at DESC)`;
}

export async function ensurePersonalProjects(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      autonomy_mode TEXT NOT NULL DEFAULT 'manual',
      execution_status TEXT NOT NULL DEFAULT 'idle',
      task_budget INTEGER NOT NULL DEFAULT 12,
      tasks_dispatched INTEGER NOT NULL DEFAULT 0,
      max_parallel_tasks INTEGER NOT NULL DEFAULT 1,
      require_approval BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_at TIMESTAMPTZ,
      target_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_projects_owner_status_idx ON omni_projects (tenant_id, actor_id, status, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_project_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES omni_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      agent_id TEXT NOT NULL DEFAULT 'atlas',
      position INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'manual',
      due_at TIMESTAMPTZ,
      dependency_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      workflow_run_id TEXT,
      workflow_status TEXT,
      execution_error TEXT,
      dispatched_at TIMESTAMPTZ,
      dispatch_attempt INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_project_position_idx ON omni_project_tasks (tenant_id, project_id, position, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_workflow_idx ON omni_project_tasks (tenant_id, workflow_run_id) WHERE workflow_run_id IS NOT NULL`;
}

export async function ensureAutonomousProjectExecution(sql: SqlClient) {
  await ensurePersonalProjects(sql);
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS autonomy_mode TEXT NOT NULL DEFAULT 'manual'`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'idle'`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS task_budget INTEGER NOT NULL DEFAULT 12`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS tasks_dispatched INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS max_parallel_tasks INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dependency_ids JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS workflow_run_id TEXT`;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'omni_project_tasks_workflow_run_fk'
      ) THEN
        ALTER TABLE omni_project_tasks
          ADD CONSTRAINT omni_project_tasks_workflow_run_fk
          FOREIGN KEY (workflow_run_id) REFERENCES omni_workflow_runs(id) ON DELETE SET NULL;
      END IF;
    END
    $migration$
  `;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS workflow_status TEXT`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS execution_error TEXT`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dispatch_attempt INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_workflow_idx ON omni_project_tasks (tenant_id, workflow_run_id) WHERE workflow_run_id IS NOT NULL`;
}

export async function ensureProjectArtifacts(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_project_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES omni_projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES omni_project_tasks(id) ON DELETE CASCADE,
      workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      source_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      evidence_refs TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, workflow_run_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_project_created_idx ON omni_project_artifacts (tenant_id, project_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_task_idx ON omni_project_artifacts (tenant_id, task_id, created_at DESC)`;
}

export async function ensureProjectArtifactReflections(sql: SqlClient) {
  await ensureProjectArtifacts(sql);
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS verdict TEXT`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS lesson TEXT`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS reflection_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_reviewed_idx ON omni_project_artifacts (tenant_id, agent_id, reviewed_at DESC) WHERE verdict IS NOT NULL`;
}

export async function ensureCaptureRecordings(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      extension TEXT NOT NULL DEFAULT '',
      byte_count INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      storage_kind TEXT NOT NULL DEFAULT 'database',
      content BYTEA NOT NULL,
      status TEXT NOT NULL DEFAULT 'stored',
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      ingest_job_id TEXT,
      knowledge_document_id TEXT,
      error TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_assets_owner_updated_idx
    ON omni_capture_assets (tenant_id, actor_id, updated_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_recordings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      language TEXT NOT NULL DEFAULT 'en-US',
      tags TEXT[] NOT NULL DEFAULT '{}',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      duration_ms BIGINT NOT NULL DEFAULT 0,
      byte_count BIGINT NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 0,
      transcript TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      knowledge_document_id TEXT,
      ingest_job_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_recordings_owner_updated_idx
    ON omni_capture_recordings (tenant_id, actor_id, updated_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_recordings_source_idx
    ON omni_capture_recordings (tenant_id, source)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_segments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      recording_id TEXT NOT NULL REFERENCES omni_capture_recordings(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      audio_sha256 TEXT NOT NULL,
      audio_data BYTEA NOT NULL,
      transcript TEXT NOT NULL DEFAULT '',
      transcription_status TEXT NOT NULL DEFAULT 'pending',
      transcription_model TEXT,
      transcription_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, recording_id, segment_index)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_segments_recording_idx
    ON omni_capture_segments (tenant_id, actor_id, recording_id, segment_index ASC)
  `;
}

export async function ensureCaptureRecordingRequestReadIndex(sql: SqlClient) {
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_recordings_request_owner_updated_idx
    ON omni_capture_recordings (
      tenant_id,
      actor_id,
      updated_at DESC,
      id COLLATE "C" ASC
    )
  `;
}

export async function ensureMissionKernel(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_missions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'archived')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      source TEXT NOT NULL DEFAULT 'user',
      source_key TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_missions_owner_status_idx ON omni_missions (tenant_id, actor_id, status, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES omni_mission_tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      definition_of_done TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('triage', 'pending', 'running', 'blocked', 'review', 'succeeded', 'failed', 'canceled')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      position INTEGER NOT NULL DEFAULT 0,
      source_key TEXT NOT NULL,
      dependency_ids TEXT[] NOT NULL DEFAULT '{}',
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, mission_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_tasks_mission_status_idx ON omni_mission_tasks (tenant_id, actor_id, mission_id, status, position, created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_attempts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES omni_mission_tasks(id) ON DELETE CASCADE,
      executor_key TEXT NOT NULL,
      executor_type TEXT NOT NULL DEFAULT 'agent',
      executor_id TEXT NOT NULL,
      fence_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled')),
      agent_run_id TEXT REFERENCES omni_agent_runs(id) ON DELETE SET NULL,
      workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, task_id, executor_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_mission_status_idx ON omni_mission_attempts (tenant_id, actor_id, mission_id, status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_task_created_idx ON omni_mission_attempts (tenant_id, actor_id, task_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_executor_idx ON omni_mission_attempts (tenant_id, actor_id, executor_type, executor_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES omni_mission_tasks(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES omni_mission_attempts(id) ON DELETE SET NULL,
      source_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'result',
      title TEXT NOT NULL,
      uri TEXT,
      mime_type TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, mission_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_artifacts_mission_created_idx ON omni_mission_artifacts (tenant_id, actor_id, mission_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_artifacts_attempt_idx ON omni_mission_artifacts (tenant_id, actor_id, attempt_id) WHERE attempt_id IS NOT NULL`;
}

export async function ensureMissionKanbanTaskMetadata(sql: SqlClient) {
  await sql`ALTER TABLE omni_mission_tasks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE omni_mission_tasks DROP CONSTRAINT IF EXISTS omni_mission_tasks_status_check`;
  await sql`
    ALTER TABLE omni_mission_tasks
    ADD CONSTRAINT omni_mission_tasks_status_check
    CHECK (status IN ('triage', 'pending', 'running', 'blocked', 'review', 'succeeded', 'failed', 'canceled'))
  `;
}
