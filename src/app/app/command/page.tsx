import type { Metadata } from "next";
import { AgentRunsWorkspace } from "@/components/agent-runs-workspace";

export const metadata: Metadata = {
  title: "Command",
};

export default async function CommandPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; thread?: string | string[]; mission?: string | string[]; prompt?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestedAgent = typeof query.agent === "string" ? query.agent : undefined;
  const initialAgentId = requestedAgent && /^[a-zA-Z0-9_.:-]{1,120}$/.test(requestedAgent) ? requestedAgent : undefined;
  const initialThreadId = typeof query.thread === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query.thread)
    ? query.thread
    : undefined;
  const initialMissionId = typeof query.mission === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query.mission)
    ? query.mission
    : undefined;
  const initialGoal = typeof query.prompt === "string" ? query.prompt.trim().slice(0, 4_000) : undefined;
  return <AgentRunsWorkspace initialAgentId={initialAgentId} initialThreadId={initialThreadId} initialMissionId={initialMissionId} initialGoal={initialGoal} />;
}
