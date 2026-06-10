import type { Metadata } from "next";
import { DocsGuide } from "@/components/marketing/docs-guide";

export const metadata: Metadata = {
  title: "How to Use OmniAgentOS",
  description: "Step-by-step guide to using OmniAgentOS, including onboarding, command center, memory, RAG, workflows, connectors, tools, evaluations, observability, security, and production operations.",
};

export default function DocsPage() {
  return <DocsGuide />;
}
