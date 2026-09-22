import type { Metadata } from "next";
import { AgentArsenalWorkspace } from "@/components/agent-arsenal-workspace";

export const metadata: Metadata = {
  title: "Agents",
};

type AgentsPageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: AgentsPageSearchParams;
}) {
  const query = await searchParams;
  return (
    <AgentArsenalWorkspace
      initialView={firstQueryValue(query.view)}
      initialRunId={firstQueryValue(query.run)}
      initialTaskId={firstQueryValue(query.task)}
    />
  );
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
