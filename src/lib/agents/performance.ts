import { arsenalAgents } from "@/lib/agents/arsenal";
import { listAgentRuns } from "@/lib/runs/store";
import { listTenantProjectArtifacts } from "@/lib/projects/store";

export type AgentPerformance = {
  agentId: string;
  primaryAssignments: number;
  collaborations: number;
  completed: number;
  failed: number;
  completionRate: number | null;
  verifiedAnswers: number;
  memoriesLearned: number;
  projectAssignments?: number;
  lessonsLearned?: number;
  latestLessons?: string[];
  usefulOutcomes: number;
  needsWorkOutcomes: number;
  userApprovalRate: number | null;
  lastActiveAt?: string;
};

export async function getAgentPerformance(tenantId?: string): Promise<AgentPerformance[]> {
  // Vercel intentionally uses a single database connection per route isolate.
  // Keep these independent root reads sequential so the second one receives a
  // fresh acquisition deadline instead of spending it queued behind the first.
  const runs = await listAgentRuns(200, { tenantId });
  const artifacts = await listTenantProjectArtifacts({
    tenantId,
    limit: 1_000,
  });
  return arsenalAgents.map((agent) => {
    const primary = runs.filter((run) => (run.agentId || "atlas") === agent.id);
    const participated = runs.filter((run) => (run.specialistIds || [run.agentId || "atlas"]).includes(agent.id));
    const projectOutcomes = artifacts.filter((artifact) => artifact.agentId === agent.id);
    const completed = primary.filter((run) => run.status === "completed").length + projectOutcomes.filter((artifact) => artifact.status === "verified").length;
    const failed = primary.filter((run) => run.status === "failed").length + projectOutcomes.filter((artifact) => artifact.status === "failed").length;
    const terminal = completed + failed;
    const usefulOutcomes = primary.filter((run) => run.feedback?.verdict === "useful").length + projectOutcomes.filter((artifact) => artifact.verdict === "useful").length;
    const needsWorkOutcomes = primary.filter((run) => run.feedback?.verdict === "needs_work").length + projectOutcomes.filter((artifact) => artifact.verdict === "needs_work").length;
    const feedbackCount = usefulOutcomes + needsWorkOutcomes;
    return {
      agentId: agent.id,
      primaryAssignments: primary.length + projectOutcomes.length,
      collaborations: Math.max(0, participated.length - primary.length),
      completed,
      failed,
      completionRate: terminal ? completed / terminal : null,
      verifiedAnswers: primary.filter((run) => run.grounding?.status === "verified").length + projectOutcomes.filter((artifact) => artifact.status === "verified").length,
      memoriesLearned: primary.reduce((sum, run) => sum + (run.consolidationCount || 0), 0) + projectOutcomes.filter((artifact) => artifact.memoryId).length,
      projectAssignments: projectOutcomes.length,
      lessonsLearned: projectOutcomes.filter((artifact) => artifact.lesson).length,
      latestLessons: projectOutcomes.map((artifact) => artifact.lesson).filter((lesson): lesson is string => Boolean(lesson)).slice(0, 3),
      usefulOutcomes,
      needsWorkOutcomes,
      userApprovalRate: feedbackCount ? usefulOutcomes / feedbackCount : null,
      lastActiveAt: [participated[0]?.startedAt, projectOutcomes[0]?.createdAt].filter((value): value is string => Boolean(value)).sort().at(-1),
    };
  });
}
