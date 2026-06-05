import { hasOpenAIKey } from "@/lib/config";
import { getMcpConnectorStats } from "@/lib/connectors/store";
import { getStorageBackend, hasDatabaseUrl } from "@/lib/db/client";
import { getMemoryStats } from "@/lib/memory/store";
import { getCapabilityRegistry } from "@/lib/orchestration/registry";
import { getKnowledgeStats } from "@/lib/rag/store";
import { getRunStats } from "@/lib/runs/store";
import { getToolExecutionStats } from "@/lib/tools/audit-store";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    openaiConfigured: hasOpenAIKey(),
    databaseConfigured: hasDatabaseUrl(),
    storageBackend: getStorageBackend(),
    memory: await getMemoryStats(),
    knowledge: await getKnowledgeStats(),
    runs: await getRunStats(),
    toolExecutions: await getToolExecutionStats(),
    mcpConnectors: await getMcpConnectorStats(),
    registry: getCapabilityRegistry(),
  });
}
