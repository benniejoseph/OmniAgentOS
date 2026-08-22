import type { Metadata } from "next";
import { AgentRunsWorkspace } from "@/components/agent-runs-workspace";

export const metadata: Metadata = {
  title: "Start",
};

export default function CommandPage() {
  return <AgentRunsWorkspace />;
}
