import type { Metadata } from "next";
import { SelfImprovementWorkspace } from "@/components/self-improvement-workspace";

export const metadata: Metadata = { title: "Self-improvement" };

export default function ImprovementPage() {
  return <SelfImprovementWorkspace />;
}
