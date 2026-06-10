import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Security",
};

export default function SecurityPage() {
  return <MarketingPage pageKey="security" />;
}
