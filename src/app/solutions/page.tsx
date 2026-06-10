import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Solutions",
};

export default function SolutionsPage() {
  return <MarketingPage pageKey="solutions" />;
}
