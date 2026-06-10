import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Pricing",
};

export default function PricingPage() {
  return <MarketingPage pageKey="pricing" />;
}
