import type { Metadata } from "next";
import { DocsGuide } from "@/components/marketing/docs-guide";

export const metadata: Metadata = {
  title: "How to Use Asael",
  description: "Step-by-step guide to using Asael, including command, memory, workflows, connectors, tools, evaluations, observability, security, and production operations.",
};

export default function DocsPage() {
  return <DocsGuide />;
}
