import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Memory + RAG",
};

export default function MemoryPage() {
  return <FeaturePage pageKey="memory" />;
}
