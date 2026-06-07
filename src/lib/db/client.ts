import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { PGVECTOR_HNSW_MAX_DIMENSIONS, VECTOR_INDEX_DIMENSIONS } from "@/lib/config";

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

export async function getVectorStoreStatus() {
  if (!hasDatabaseUrl()) {
    return {
      configured: false,
      hnswSupported: VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
      dimensions: VECTOR_INDEX_DIMENSIONS,
    };
  }

  await ensureDatabaseSchema();
  const [extensionRows, indexRows] = await Promise.all([
    getSql()`SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1`,
    getSql()`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'omni_memories_embedding_vector_idx',
          'omni_knowledge_chunks_embedding_vector_idx'
        )
    `,
  ]);
  const indexNames = new Set(indexRows.map((row) => String(row.indexname)));
  const memoryColumnDimensions = await getVectorColumnDimensions(getSql(), "omni_memories");
  const knowledgeColumnDimensions = await getVectorColumnDimensions(getSql(), "omni_knowledge_chunks");

  return {
    configured:
      Boolean(extensionRows[0]) &&
      memoryColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
      knowledgeColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
      indexNames.has("omni_memories_embedding_vector_idx") &&
      indexNames.has("omni_knowledge_chunks_embedding_vector_idx"),
    extensionInstalled: Boolean(extensionRows[0]),
    extensionVersion: extensionRows[0]?.extversion ? String(extensionRows[0].extversion) : undefined,
    dimensions: VECTOR_INDEX_DIMENSIONS,
    hnswSupported: VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
    memoryColumnDimensions,
    knowledgeColumnDimensions,
    memoryIndexed: indexNames.has("omni_memories_embedding_vector_idx"),
    knowledgeIndexed: indexNames.has("omni_knowledge_chunks_embedding_vector_idx"),
  };
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
            tenant_id TEXT NOT NULL DEFAULT 'default',
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
        await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
        await sql`CREATE INDEX IF NOT EXISTS omni_memories_tenant_updated_at_idx ON omni_memories (tenant_id, updated_at DESC)`;
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
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_knowledge_documents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_updated_at_idx ON omni_knowledge_documents (tenant_id, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_updated_at_idx ON omni_knowledge_documents (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_source_idx ON omni_knowledge_documents (source)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tags_idx ON omni_knowledge_documents USING GIN (tags)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_knowledge_chunks (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_knowledge_chunks ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_updated_at_idx ON omni_knowledge_chunks (tenant_id, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_document_id_idx ON omni_knowledge_chunks (document_id, chunk_index ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_updated_at_idx ON omni_knowledge_chunks (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tags_idx ON omni_knowledge_chunks USING GIN (tags)`;
      await sql`
        CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_text_idx
        ON omni_knowledge_chunks
        USING GIN (to_tsvector('english', title || ' ' || content))
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_retrieval_traces (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          profile JSONB NOT NULL DEFAULT '{}',
          result_count INTEGER NOT NULL DEFAULT 0,
          selected_count INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          results JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_retrieval_traces_created_at_idx ON omni_retrieval_traces (created_at DESC)`;
      await sql`
        CREATE INDEX IF NOT EXISTS omni_retrieval_traces_mode_idx
        ON omni_retrieval_traces ((profile->>'mode'))
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_memory_graph_nodes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          aliases TEXT[] NOT NULL DEFAULT '{}',
          summary TEXT NOT NULL DEFAULT '',
          weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          source_count INTEGER NOT NULL DEFAULT 0,
          memory_ids TEXT[] NOT NULL DEFAULT '{}',
          trace_ids TEXT[] NOT NULL DEFAULT '{}',
          tags TEXT[] NOT NULL DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_kind_idx ON omni_memory_graph_nodes (kind)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_updated_at_idx ON omni_memory_graph_nodes (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tags_idx ON omni_memory_graph_nodes USING GIN (tags)`;
      await sql`
        CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_text_idx
        ON omni_memory_graph_nodes
        USING GIN (to_tsvector('english', label || ' ' || summary))
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_memory_graph_edges (
          id TEXT PRIMARY KEY,
          source_node_id TEXT NOT NULL REFERENCES omni_memory_graph_nodes(id) ON DELETE CASCADE,
          target_node_id TEXT NOT NULL REFERENCES omni_memory_graph_nodes(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          evidence_count INTEGER NOT NULL DEFAULT 0,
          memory_ids TEXT[] NOT NULL DEFAULT '{}',
          trace_ids TEXT[] NOT NULL DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_source_idx ON omni_memory_graph_edges (source_node_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_target_idx ON omni_memory_graph_edges (target_node_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_relation_idx ON omni_memory_graph_edges (relation)`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_graph_edges_unique_idx
        ON omni_memory_graph_edges (source_node_id, target_node_id, relation)
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_memory_graph_builds (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          memory_count INTEGER NOT NULL DEFAULT 0,
          trace_count INTEGER NOT NULL DEFAULT 0,
          node_count INTEGER NOT NULL DEFAULT 0,
          edge_count INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_builds_created_at_idx ON omni_memory_graph_builds (created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_agent_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_count INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ`;
      await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_error TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_started_at_idx ON omni_agent_runs (started_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_started_at_idx ON omni_agent_runs (tenant_id, started_at DESC)`;
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
          tenant_id TEXT,
          actor_id TEXT,
          input JSONB NOT NULL DEFAULT '{}',
          output JSONB,
          reason TEXT,
          approval_decision TEXT,
          approved_by TEXT,
          approved_at TIMESTAMPTZ,
          approval_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS tenant_id TEXT`;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS actor_id TEXT`;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approval_decision TEXT`;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approved_by TEXT`;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
      await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approval_reason TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_tool_id_idx ON omni_tool_executions (tool_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_status_idx ON omni_tool_executions (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_created_at_idx ON omni_tool_executions (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_tenant_status_idx ON omni_tool_executions (tenant_id, status)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_mcp_connectors (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_status_idx ON omni_mcp_connectors (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_updated_at_idx ON omni_mcp_connectors (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_tenant_updated_at_idx ON omni_mcp_connectors (tenant_id, updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_mcp_tools (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_mcp_tools ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_connector_id_idx ON omni_mcp_tools (connector_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_status_idx ON omni_mcp_tools (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_tenant_connector_idx ON omni_mcp_tools (tenant_id, connector_id)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_mcp_tools_connector_name_idx ON omni_mcp_tools (connector_id, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_openapi_connectors (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_openapi_connectors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_status_idx ON omni_openapi_connectors (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_updated_at_idx ON omni_openapi_connectors (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_tenant_updated_at_idx ON omni_openapi_connectors (tenant_id, updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_openapi_operations (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_openapi_operations ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_connector_id_idx ON omni_openapi_operations (connector_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_status_idx ON omni_openapi_operations (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_tenant_connector_idx ON omni_openapi_operations (tenant_id, connector_id)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_openapi_operations_connector_operation_idx ON omni_openapi_operations (connector_id, operation_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_workflow_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_status_idx ON omni_workflow_runs (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_updated_at_idx ON omni_workflow_runs (updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_tenant_updated_at_idx ON omni_workflow_runs (tenant_id, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_workflow_type_idx ON omni_workflow_runs (workflow_type)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_plans (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          planner TEXT NOT NULL,
          model TEXT,
          plan JSONB NOT NULL DEFAULT '{}',
          validation JSONB NOT NULL DEFAULT '{}',
          context_trace_id TEXT,
          highest_risk_level INTEGER NOT NULL DEFAULT 0,
          approval_required BOOLEAN NOT NULL DEFAULT FALSE,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE omni_workflow_plans ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_run_id_idx ON omni_workflow_plans (workflow_run_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_status_idx ON omni_workflow_plans (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_created_at_idx ON omni_workflow_plans (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_tenant_created_at_idx ON omni_workflow_plans (tenant_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_risk_idx ON omni_workflow_plans (highest_risk_level DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_node_executions (
          id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES omni_workflow_plans(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          node_label TEXT NOT NULL,
          node_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          policy TEXT NOT NULL,
          risk_level INTEGER NOT NULL DEFAULT 0,
          approval_required BOOLEAN NOT NULL DEFAULT FALSE,
          tool_execution_ids TEXT[] NOT NULL DEFAULT '{}',
          input JSONB NOT NULL DEFAULT '{}',
          output JSONB,
          error TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_run_idx ON omni_workflow_node_executions (workflow_run_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_plan_idx ON omni_workflow_node_executions (plan_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_status_idx ON omni_workflow_node_executions (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_updated_idx ON omni_workflow_node_executions (updated_at DESC)`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_node_exec_plan_node_idx
        ON omni_workflow_node_executions (plan_id, node_id)
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_triggers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          auth_mode TEXT NOT NULL DEFAULT 'hmac_sha256',
          secret_env_var TEXT,
          goal_template TEXT NOT NULL,
          workflow_mode TEXT NOT NULL DEFAULT 'orchestrate',
          require_approval BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}',
          trigger_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_triggered_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_status_idx ON omni_workflow_triggers (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_source_idx ON omni_workflow_triggers (source)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_updated_idx ON omni_workflow_triggers (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_operation_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          dedupe_key TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          locked_at TIMESTAMPTZ,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_status_run_at_idx ON omni_operation_jobs (status, run_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_type_status_idx ON omni_operation_jobs (type, status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_updated_at_idx ON omni_operation_jobs (updated_at DESC)`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS omni_operation_jobs_dedupe_key_idx
        ON omni_operation_jobs (dedupe_key)
        WHERE dedupe_key IS NOT NULL
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_workflow_trigger_events (
          id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL REFERENCES omni_workflow_triggers(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          event_type TEXT,
          signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
          workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
          queue_job_id TEXT REFERENCES omni_operation_jobs(id) ON DELETE SET NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          headers JSONB NOT NULL DEFAULT '{}',
          error TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_trigger_idx ON omni_workflow_trigger_events (trigger_id, received_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_status_idx ON omni_workflow_trigger_events (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_received_idx ON omni_workflow_trigger_events (received_at DESC)`;

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
        CREATE TABLE IF NOT EXISTS omni_system_health_checks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          scope TEXT NOT NULL,
          components JSONB NOT NULL DEFAULT '[]',
          metrics JSONB NOT NULL DEFAULT '{}',
          incidents JSONB NOT NULL DEFAULT '[]',
          recovery_actions JSONB NOT NULL DEFAULT '[]',
          latency_ms INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_status_idx ON omni_system_health_checks (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_created_idx ON omni_system_health_checks (created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_incidents (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          component_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          last_check_id TEXT,
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          acknowledged_at TIMESTAMPTZ,
          acknowledged_by TEXT,
          acknowledgement_reason TEXT,
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT,
          resolution TEXT,
          alert_targets JSONB NOT NULL DEFAULT '[]',
          playbook_ids TEXT[] NOT NULL DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_incidents_status_idx ON omni_incidents (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_incidents_component_idx ON omni_incidents (component_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_incidents_severity_idx ON omni_incidents (severity)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_incidents_updated_idx ON omni_incidents (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_incident_events (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL REFERENCES omni_incidents(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          actor_id TEXT,
          message TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_incident_idx ON omni_incident_events (incident_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_created_idx ON omni_incident_events (created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_alert_deliveries (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL REFERENCES omni_incidents(id) ON DELETE CASCADE,
          incident_event_id TEXT,
          target_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          payload JSONB NOT NULL DEFAULT '{}',
          response JSONB,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          locked_at TIMESTAMPTZ,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivered_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_status_run_idx ON omni_alert_deliveries (status, run_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_incident_idx ON omni_alert_deliveries (incident_id, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_target_idx ON omni_alert_deliveries (target_id, status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_updated_idx ON omni_alert_deliveries (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_eval_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_eval_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_status_idx ON omni_eval_runs (status)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_created_at_idx ON omni_eval_runs (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_tenant_created_at_idx ON omni_eval_runs (tenant_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_eval_results (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
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
      await sql`ALTER TABLE omni_eval_results ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_run_id_idx ON omni_eval_results (eval_run_id, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_case_id_idx ON omni_eval_results (case_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_tenant_run_idx ON omni_eval_results (tenant_id, eval_run_id, created_at ASC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_eval_reports (
          id TEXT PRIMARY KEY,
          eval_run_id TEXT NOT NULL REFERENCES omni_eval_runs(id) ON DELETE CASCADE,
          format TEXT NOT NULL,
          report_version TEXT NOT NULL,
          report JSONB NOT NULL DEFAULT '{}',
          signature JSONB NOT NULL DEFAULT '{}',
          tenant_id TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_run_created_idx ON omni_eval_reports (eval_run_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_created_idx ON omni_eval_reports (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_tenant_run_created_idx ON omni_eval_reports (tenant_id, eval_run_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_auth_tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_tenants_slug_idx ON omni_auth_tenants (slug)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_auth_users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT,
          password_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          last_login_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_users_email_idx ON omni_auth_users (email)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_users_status_idx ON omni_auth_users (status)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_auth_memberships (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_auth_memberships_tenant_user_idx ON omni_auth_memberships (tenant_id, user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_memberships_user_idx ON omni_auth_memberships (user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_memberships_role_idx ON omni_auth_memberships (role)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_token_hash_idx ON omni_auth_sessions (token_hash)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_user_idx ON omni_auth_sessions (user_id)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_expires_idx ON omni_auth_sessions (expires_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_security_audits (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          decision TEXT NOT NULL,
          reason TEXT,
          risk_level INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_tenant_created_idx ON omni_security_audits (tenant_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_action_idx ON omni_security_audits (action)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_decision_idx ON omni_security_audits (decision)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_observability_events (
          id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          route TEXT,
          method TEXT,
          status_code INTEGER,
          duration_ms INTEGER,
          request_id TEXT,
          correlation_id TEXT NOT NULL,
          tenant_id TEXT,
          actor_id TEXT,
          resource_type TEXT,
          resource_id TEXT,
          message TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_level_created_idx ON omni_observability_events (level, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_category_created_idx ON omni_observability_events (category, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_correlation_idx ON omni_observability_events (correlation_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_route_created_idx ON omni_observability_events (route, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_resource_created_idx ON omni_observability_events (resource_type, resource_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_tenant_created_idx ON omni_observability_events (tenant_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_observability_slo_policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          metric TEXT NOT NULL,
          comparator TEXT NOT NULL,
          warning_threshold DOUBLE PRECISION NOT NULL,
          critical_threshold DOUBLE PRECISION NOT NULL,
          warning_severity TEXT NOT NULL DEFAULT 'warning',
          critical_severity TEXT NOT NULL DEFAULT 'critical',
          unit TEXT NOT NULL,
          component_id TEXT NOT NULL DEFAULT 'observability',
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          alert_target_ids TEXT[] NOT NULL DEFAULT '{}',
          suppression_minutes INTEGER NOT NULL DEFAULT 120,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_enabled_idx ON omni_observability_slo_policies (enabled, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_metric_idx ON omni_observability_slo_policies (metric)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_observability_slo_policy_changes (
          id TEXT PRIMARY KEY,
          policy_id TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          risk_level INTEGER NOT NULL DEFAULT 2,
          tenant_id TEXT,
          requested_by TEXT,
          reviewed_by TEXT,
          reason TEXT,
          review_reason TEXT,
          before_policy JSONB,
          after_policy JSONB,
          rollback_change_id TEXT,
          approval_policy JSONB NOT NULL DEFAULT '{}',
          approvals JSONB NOT NULL DEFAULT '[]',
          evidence_hash TEXT NOT NULL DEFAULT '',
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ
        )
      `;
      await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS approval_policy JSONB NOT NULL DEFAULT '{}'`;
      await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS evidence_hash TEXT NOT NULL DEFAULT ''`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_policy_idx ON omni_observability_slo_policy_changes (policy_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_status_idx ON omni_observability_slo_policy_changes (status, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_action_idx ON omni_observability_slo_policy_changes (action)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_tenant_status_idx ON omni_observability_slo_policy_changes (tenant_id, status, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS omni_observability_slo_approval_policies (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          rules JSONB NOT NULL DEFAULT '[]',
          break_glass JSONB NOT NULL DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}',
          updated_by TEXT,
          update_reason TEXT,
          evidence_hash TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS omni_observability_slo_approval_policy_versions (
          id TEXT PRIMARY KEY,
          policy_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          policy JSONB NOT NULL DEFAULT '{}',
          changed_by TEXT,
          change_reason TEXT,
          previous_hash TEXT,
          evidence_hash TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_approval_policy_versions_policy_idx ON omni_observability_slo_approval_policy_versions (policy_id, version DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_approval_policy_versions_created_idx ON omni_observability_slo_approval_policy_versions (created_at DESC)`;
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
    await ensureVectorColumn({
      sql,
      tableName: "omni_memories",
      indexName: "omni_memories_embedding_vector_idx",
    });
    await ensureVectorColumn({
      sql,
      tableName: "omni_knowledge_chunks",
      indexName: "omni_knowledge_chunks_embedding_vector_idx",
    });
  } catch (error) {
    if (process.env.OMNIAGENT_LOG_PGVECTOR_FAILURES === "true") {
      console.info(
        "pgvector schema unavailable; continuing with JSON embeddings.",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function ensureVectorColumn({
  sql,
  tableName,
  indexName,
}: {
  sql: SqlClient;
  tableName: "omni_memories" | "omni_knowledge_chunks";
  indexName: string;
}) {
  const dimensions = await getVectorColumnDimensions(sql, tableName);
  if (dimensions !== VECTOR_INDEX_DIMENSIONS) {
    await sql.query(`DROP INDEX IF EXISTS ${indexName}`);
    await sql.query(`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS embedding_vector`);
    await sql.query(`ALTER TABLE ${tableName} ADD COLUMN embedding_vector vector(${VECTOR_INDEX_DIMENSIONS})`);
  }

  await backfillVectorColumn(sql, tableName);

  if (VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS) {
    await sql.query(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON ${tableName}
      USING hnsw (embedding_vector vector_cosine_ops)
    `);
  }
}

async function getVectorColumnDimensions(
  sql: SqlClient,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  const rows = await sql.query(
    `
      SELECT CASE WHEN attribute.atttypmod >= 0 THEN attribute.atttypmod ELSE NULL END AS dimensions
      FROM pg_attribute attribute
      JOIN pg_class class ON class.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND class.relname = $1
        AND attribute.attname = 'embedding_vector'
        AND NOT attribute.attisdropped
      LIMIT 1
    `,
    [tableName],
  );

  return rows[0]?.dimensions === null || rows[0]?.dimensions === undefined
    ? undefined
    : Number(rows[0].dimensions);
}

async function backfillVectorColumn(
  sql: SqlClient,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  await sql.query(`
    UPDATE ${tableName}
    SET embedding_vector = (
      '[' || (
        SELECT string_agg(item.value::text, ',' ORDER BY item.ordinality)
        FROM jsonb_array_elements_text(embedding) WITH ORDINALITY AS item(value, ordinality)
        WHERE item.ordinality <= ${VECTOR_INDEX_DIMENSIONS}
      ) || ']'
    )::vector
    WHERE embedding_vector IS NULL
      AND CASE
        WHEN jsonb_typeof(embedding) = 'array'
        THEN jsonb_array_length(embedding) >= ${VECTOR_INDEX_DIMENSIONS}
        ELSE false
      END
  `);
}
