import { listCustomAgents, listCustomAgentsForRequest } from "@/lib/skills/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { parentContinuationRunId } from "@/lib/delegation/parent-continuation-identity";
import { listDelegationExecutions } from "@/lib/delegation/execution-store";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { listAgentRuns } from "@/lib/runs/store";
import { listTenantProjectArtifacts } from "@/lib/projects/store";

export type AgentPerformance = {
  agentId: string;
  primaryAssignments: number;
  collaborations: number;
  /** Accepted root outcomes; a finished run alone is not success. */
  completed: number;
  runsFinished?: number;
  partial?: number;
  blocked?: number;
  canceled?: number;
  unassessed?: number;
  window?: { runs: number; artifacts: number; delegations: number };
  failed: number;
  completionRate: number | null;
  verifiedAnswers: number;
  memoriesFormed: number;
  projectAssignments?: number;
  reviewedOutcomeNotes?: number;
  latestOutcomeNotes?: string[];
  usefulOutcomes: number;
  needsWorkOutcomes: number;
  userApprovalRate: number | null;
  lastActiveAt?: string;
};

export async function getAgentPerformance(tenantId?: string, actorId?: string, requestActorBinding?: CanonicalRequestActorBindingV1): Promise<AgentPerformance[]> {
  // Vercel intentionally uses a single database connection per route isolate.
  // Keep these independent root reads sequential so the second one receives a
  // fresh acquisition deadline instead of spending it queued behind the first.
  const runs = await listAgentRuns(200, { tenantId });
  const artifacts = await listTenantProjectArtifacts({
    tenantId,
    limit: 1_000,
  });
  const custom = actorId ? requestActorBinding ? await listCustomAgentsForRequest({ tenantId, actorId, requestActorBinding }) : await listCustomAgents({ tenantId, actorId }) : [];
  const delegations = tenantId && actorId ? await listDelegationExecutions({ tenantId, ownerActorId: requestActorBinding?.canonicalActorId || actorId, childRunIds: runs.map(run => run.id), limit: 200 }) : [];
  const childRunIds = new Set(delegations.map(task => task.childRunId));
  const runIds = new Set(runs.map(run => run.id));
  const agentIds = [...new Set([...arsenalAgents.map(agent => agent.id), ...custom.map(agent => agent.id), ...runs.map(run => run.agentId || "atlas"), ...artifacts.map(artifact => artifact.agentId)])];
  return agentIds.map((agentId) => {
    const agent = { id: agentId };
    const primary = runs.filter((run) => (run.agentId || "atlas") === agent.id);
    const participated = primary;
    const goals = primary.filter(run => !childRunIds.has(run.id) && !runIds.has(parentContinuationRunId(run.id)));
    const projectOutcomes = artifacts.filter((artifact) => artifact.agentId === agent.id);
    const completed = goals.filter(run => run.feedback ? run.feedback.verdict === "useful"
      : run.terminalReceipt?.source === "outcome_evaluator" && run.terminalReceipt.disposition === "succeeded").length;
    const failed = primary.filter((run) => run.status === "failed").length + projectOutcomes.filter((artifact) => artifact.status === "failed").length;
    const assessed = goals.filter(run => run.terminalReceipt?.source === "outcome_evaluator" || run.feedback).length;
    const usefulOutcomes = primary.filter((run) => run.feedback?.verdict === "useful").length + projectOutcomes.filter((artifact) => artifact.verdict === "useful").length;
    const needsWorkOutcomes = primary.filter((run) => run.feedback?.verdict === "needs_work").length + projectOutcomes.filter((artifact) => artifact.verdict === "needs_work").length;
    const feedbackCount = usefulOutcomes + needsWorkOutcomes;
    return {
      agentId: agent.id,
      primaryAssignments: primary.length + projectOutcomes.length,
      collaborations: delegations.filter(task => task.delegateAgentId === agent.id && primary.some(run => run.id === task.childRunId && run.status !== "queued")).length,
      completed,
      runsFinished: primary.filter(run => run.status === "completed").length,
      partial: goals.filter(run => run.terminalReceipt?.disposition === "partial").length,
      blocked: goals.filter(run => run.status === "waiting_approval" || run.status === "waiting_clarification").length,
      canceled: goals.filter(run => run.status === "canceled").length,
      unassessed: goals.filter(run => !run.feedback && run.terminalReceipt?.source !== "outcome_evaluator").length,
      window: { runs: runs.length, artifacts: artifacts.length, delegations: delegations.length },
      failed,
      completionRate: assessed ? completed / assessed : null,
      verifiedAnswers: primary.filter((run) => run.grounding?.status === "verified").length + projectOutcomes.filter((artifact) => artifact.status === "verified").length,
      memoriesFormed: primary.reduce((sum, run) => sum + (run.consolidationCount || 0), 0) + projectOutcomes.filter((artifact) => artifact.memoryId).length,
      projectAssignments: projectOutcomes.length,
      reviewedOutcomeNotes: projectOutcomes.filter((artifact) => artifact.lesson).length,
      latestOutcomeNotes: projectOutcomes.map((artifact) => artifact.lesson).filter((lesson): lesson is string => Boolean(lesson)).slice(0, 3),
      usefulOutcomes,
      needsWorkOutcomes,
      userApprovalRate: feedbackCount ? usefulOutcomes / feedbackCount : null,
      lastActiveAt: [participated[0]?.startedAt, projectOutcomes[0]?.createdAt].filter((value): value is string => Boolean(value)).sort().at(-1),
    };
  });
}
