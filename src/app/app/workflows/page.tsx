import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Workflows",
};

export default function WorkflowsPage() {
  return <FeaturePage pageKey="workflows" />;
}
