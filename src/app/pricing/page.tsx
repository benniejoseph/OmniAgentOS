import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Asael is privately operated for approved accounts. This deployment has no public plans, registration, or commercial checkout.",
};

export default function PricingPage() {
  return <MarketingPage pageKey="pricing" />;
}
