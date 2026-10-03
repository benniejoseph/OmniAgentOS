import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Security",
  description: "Platform controls for tenant isolation, governed tool execution, audit history, and release evidence in Asael.",
};

export default function SecurityPage() {
  return <MarketingPage pageKey="security" />;
}
