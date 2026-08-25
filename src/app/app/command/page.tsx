import type { Metadata } from "next";
import { AgentRunsWorkspace } from "@/components/agent-runs-workspace";

export const metadata: Metadata = {
  title: "Ask",
};

const agentIds = ["atlas", "scout", "forge", "sentinel", "mnemosyne"] as const;

export default async function CommandPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; thread?: string | string[]; prompt?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestedAgent = typeof query.agent === "string" ? query.agent : undefined;
  const initialAgentId = agentIds.find((agentId) => agentId === requestedAgent);
  const initialThreadId = typeof query.thread === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query.thread)
    ? query.thread
    : undefined;
  const initialGoal = typeof query.prompt === "string" ? query.prompt.trim().slice(0, 4_000) : undefined;
  return <AgentRunsWorkspace initialAgentId={initialAgentId} initialThreadId={initialThreadId} initialGoal={initialGoal} />;
}
