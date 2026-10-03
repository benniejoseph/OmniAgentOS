import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Solutions",
  description: "Research, operations, and other multi-step AI work with memory, explicit review points, and governed tools.",
};

export default function SolutionsPage() {
  return <MarketingPage pageKey="solutions" />;
}
