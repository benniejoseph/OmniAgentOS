import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Workflows",
};

export default function WorkflowsPage() {
  return <DomainConsole domain="workflows" />;
}
