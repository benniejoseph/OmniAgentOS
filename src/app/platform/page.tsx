import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Platform",
  description: "Goals, source context, governed tools, workflows, approvals, and result evidence in the private Asael workspace.",
};

export default function PlatformPage() {
  return <MarketingPage pageKey="platform" />;
}
