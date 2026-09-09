import type { Metadata } from "next";
import { MemoryIntelligenceWorkspace } from "@/components/memory-intelligence-workspace";

export const metadata: Metadata = {
  title: "Memory",
};

export default function MemoryPage() {
  return <MemoryIntelligenceWorkspace />;
}
