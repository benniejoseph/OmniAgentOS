import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Tools",
};

export default function ToolsPage() {
  return <FeaturePage pageKey="tools" />;
}
