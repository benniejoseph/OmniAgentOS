import type { Metadata } from "next";
import { WorkflowsWorkspace } from "@/components/workflows-workspace";

export const metadata: Metadata = {
  title: "Workflows",
};

export default function WorkflowsPage() {
  return <WorkflowsWorkspace />;
}
