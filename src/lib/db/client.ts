import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { EMBEDDING_DIMENSIONS } from "@/lib/config";

type SqlClient = NeonQueryFunction<false, false>;

let sqlClient: SqlClient | null = null;
let schemaReady: Promise<void> | null = null;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getStorageBackend() {
  if (hasDatabaseUrl()) {
    return "postgres";
  }

  if (process.env.VERCEL) {
    return "ephemeral";
  }

  return "file";
}

export function getSql() {
  if (!hasDatabaseUrl()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!sqlClient) {
    sqlClient = neon(process.env.DATABASE_URL!);
  }

  return sqlClient;
}

export async function ensureDatabaseSchema() {
  if (!hasDatabaseUrl()) {
    return;
  }

  if (!schemaReady) {
    const sql = getSql();
    schemaReady = (async () => {
      await sql`SELECT pg_advisory_lock(271828182)`;
      try {
      await sql`
        CREATE TABLE IF NOT EXISTS omni_memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT[] NOT NULL DEFAULT '{}',
          scope TEXT NOT NULL,
          source TEXT NOT NULL,
          importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          embedding JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_memories_type_idx ON omni_memories (type)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memories_updated_at_idx ON omni_memories (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memories_tags_idx ON omni_memories USING GIN (tags)`;
      await sql`
        CREATE INDEX IF NOT EXISTS omni_memories_text_idx
        ON omni_memories
        USING GIN (to_tsvector('english', title || ' ' || content))
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_knowledge_documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'text',
          tags TEXT[] NOT NULL DEFAULT '{}',
          content_hash TEXT NOT NULL,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          total_characters INTEGER NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_updated_at_idx ON omni_knowledge_documents (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_source_idx ON omni_knowledge_documents (source)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tags_idx ON omni_knowledge_documents USING GIN (tags)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_knowledge_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES omni_knowledge_documents(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT[] NOT NULL DEFAULT '{}',
          source TEXT NOT NULL,
          token_estimate INTEGER NOT NULL DEFAULT 0,
          character_count INTEGER NOT NULL DEFAULT 0,
          embedding JSONB,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_document_id_idx ON omni_knowledge_chunks (document_id, chunk_index ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_updated_at_idx ON omni_knowledge_chunks (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tags_idx ON omni_knowledge_chunks USING GIN (tags)`;
      await sql`
        CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_text_idx
        ON omni_knowledge_chunks
        USING GIN (to_tsvector('english', title || ' ' || content))
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_agent_runs (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL,
          messages JSONB NOT NULL DEFAULT '[]',
          model TEXT,
          memory_context_count INTEGER NOT NULL DEFAULT 0,
          consolidation_count INTEGER NOT NULL DEFAULT 0,
          response TEXT,
          error TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          consolidated_at TIMESTAMPTZ,
          consolidation_error TEXT
        )
      `;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_count INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ`;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_error TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_started_at_idx ON omni_agent_runs (started_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_status_idx ON omni_agent_runs (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_consolidated_at_idx ON omni_agent_runs (consolidated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_agent_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES omni_agent_runs(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_events_run_id_idx ON omni_agent_events (run_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_events_type_idx ON omni_agent_events (type)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_tool_executions (
          id TEXT PRIMARY KEY,
          tool_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          risk_level INTEGER NOT NULL,
          status TEXT NOT NULL,
          dry_run BOOLEAN NOT NULL DEFAULT FALSE,
          approval_required BOOLEAN NOT NULL DEFAULT FALSE,
          input JSONB NOT NULL DEFAULT '{}',
          output JSONB,
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_tool_id_idx ON omni_tool_executions (tool_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_status_idx ON omni_tool_executions (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_created_at_idx ON omni_tool_executions (created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_mcp_connectors (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'streamable_http',
          auth_type TEXT NOT NULL DEFAULT 'none',
          auth_token_env TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          default_risk_level INTEGER NOT NULL DEFAULT 2,
          approval_required BOOLEAN NOT NULL DEFAULT TRUE,
          tool_count INTEGER NOT NULL DEFAULT 0,
          capabilities JSONB NOT NULL DEFAULT '{}',
          instructions TEXT,
          server_version JSONB,
          last_discovered_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_status_idx ON omni_mcp_connectors (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_updated_at_idx ON omni_mcp_connectors (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_mcp_tools (
          id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL REFERENCES omni_mcp_connectors(id) ON DELETE CASCADE,
          connector_name TEXT NOT NULL,
          name TEXT NOT NULL,
          title TEXT,
          description TEXT,
          input_schema JSONB NOT NULL DEFAULT '{}',
          output_schema JSONB,
          annotations JSONB,
          risk_level INTEGER NOT NULL DEFAULT 2,
          approval_required BOOLEAN NOT NULL DEFAULT TRUE,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_connector_id_idx ON omni_mcp_tools (connector_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_status_idx ON omni_mcp_tools (status)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_mcp_tools_connector_name_idx ON omni_mcp_tools (connector_id, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_openapi_connectors (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          spec_url TEXT,
          spec_hash TEXT,
          base_url TEXT NOT NULL,
          auth_type TEXT NOT NULL DEFAULT 'none',
          auth_token_env TEXT,
          auth_header_name TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          default_risk_level INTEGER NOT NULL DEFAULT 2,
          approval_required BOOLEAN NOT NULL DEFAULT TRUE,
          operation_count INTEGER NOT NULL DEFAULT 0,
          info JSONB NOT NULL DEFAULT '{}',
          last_imported_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_status_idx ON omni_openapi_connectors (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_updated_at_idx ON omni_openapi_connectors (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_openapi_operations (
          id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL REFERENCES omni_openapi_connectors(id) ON DELETE CASCADE,
          connector_name TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          summary TEXT,
          description TEXT,
          input_schema JSONB NOT NULL DEFAULT '{}',
          request_content_type TEXT,
          response_content_types TEXT[] NOT NULL DEFAULT '{}',
          risk_level INTEGER NOT NULL DEFAULT 2,
          approval_required BOOLEAN NOT NULL DEFAULT TRUE,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_connector_id_idx ON omni_openapi_operations (connector_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_status_idx ON omni_openapi_operations (status)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_openapi_operations_connector_operation_idx ON omni_openapi_operations (connector_id, operation_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_runs (
          id TEXT PRIMARY KEY,
          workflow_type TEXT NOT NULL,
          status TEXT NOT NULL,
          goal TEXT NOT NULL,
          input JSONB NOT NULL DEFAULT '{}',
          current_step TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          approval_required BOOLEAN NOT NULL DEFAULT FALSE,
          approved_at TIMESTAMPTZ,
          paused_at TIMESTAMPTZ,
          canceled_at TIMESTAMPTZ,
          error TEXT,
          result JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_status_idx ON omni_workflow_runs (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_updated_at_idx ON omni_workflow_runs (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_workflow_type_idx ON omni_workflow_runs (workflow_type)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_steps (
          id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
          step_key TEXT NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          input JSONB NOT NULL DEFAULT '{}',
          output JSONB,
          error TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_steps_run_id_idx ON omni_workflow_steps (workflow_run_id, created_at ASC)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_steps_run_step_idx ON omni_workflow_steps (workflow_run_id, step_key)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_events (
          id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_events_run_id_idx ON omni_workflow_events (workflow_run_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_events_type_idx ON omni_workflow_events (type)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_eval_runs (
          id TEXT PRIMARY KEY,
          suite TEXT NOT NULL,
          status TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          passed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          warnings INTEGER NOT NULL DEFAULT 0,
          average_latency_ms INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          error TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_status_idx ON omni_eval_runs (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_created_at_idx ON omni_eval_runs (created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_eval_results (
          id TEXT PRIMARY KEY,
          eval_run_id TEXT NOT NULL REFERENCES omni_eval_runs(id) ON DELETE CASCADE,
          case_id TEXT NOT NULL,
          case_name TEXT NOT NULL,
          case_type TEXT NOT NULL,
          status TEXT NOT NULL,
          score DOUBLE PRECISION NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          input JSONB NOT NULL DEFAULT '{}',
          output JSONB,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_run_id_idx ON omni_eval_results (eval_run_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_case_id_idx ON omni_eval_results (case_id)`;
      await ensureVectorSchema(sql);
      } finally {
        await sql`SELECT pg_advisory_unlock(271828182)`;
      }
    })();
  }

  try {
    await schemaReady;
  } catch (error) {
    schemaReady = null;
    throw error;
  }
}

async function ensureVectorSchema(sql: SqlClient) {
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql.query(`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS embedding_vector vector(${EMBEDDING_DIMENSIONS})`);
    await sql.query(
      `ALTER TABLE omni_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector(${EMBEDDING_DIMENSIONS})`,
    );
    await sql`
      CREATE INDEX IF NOT EXISTS omni_memories_embedding_vector_idx
      ON omni_memories
      USING hnsw (embedding_vector vector_cosine_ops)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_embedding_vector_idx
      ON omni_knowledge_chunks
      USING hnsw (embedding_vector vector_cosine_ops)
    `;
  } catch (error) {
    console.warn(
      "pgvector schema unavailable; continuing with JSON embeddings.",
      error instanceof Error ? error.message : error,
    );
  }
}
