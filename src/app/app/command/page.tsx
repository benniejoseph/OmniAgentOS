import type { Metadata } from "next";
import { AgentRunsWorkspace } from "@/components/agent-runs-workspace";

export const metadata: Metadata = {
  title: "Agent Runs",
};

export default function CommandPage() {
  return <AgentRunsWorkspace />;
}
