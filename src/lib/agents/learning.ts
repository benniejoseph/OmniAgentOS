import { listTenantProjectArtifacts } from "@/lib/projects/store";
import { getAgentFeedbackGuidance } from "@/lib/runs/store";

export async function getAgentLearningGuidance(
  agentId: string,
  options: { tenantId?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit || 5, 1), 10);
  const [runCorrections, artifacts] = await Promise.all([
    getAgentFeedbackGuidance(agentId, { tenantId: options.tenantId, limit }),
    listTenantProjectArtifacts({ tenantId: options.tenantId, limit: 500 }),
  ]);
  const artifactLessons = artifacts
    .filter((artifact) => artifact.agentId === agentId && artifact.lesson)
    .sort((left, right) => (right.reviewedAt || right.updatedAt).localeCompare(left.reviewedAt || left.updatedAt))
    .map((artifact) => `${artifact.verdict === "useful" ? "Repeat" : "Improve"}: ${artifact.lesson}`);
  return [...new Set([...runCorrections.map((item) => `Improve: ${item}`), ...artifactLessons])]
    .slice(0, limit);
}
