import type { Metadata } from "next";
import { AgentArsenalWorkspace } from "@/components/agent-arsenal-workspace";

export const metadata: Metadata = {
  title: "Arsenal",
};

export default function AgentsPage() { return <AgentArsenalWorkspace />; }
