import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Changelog",
};

export default function ChangelogPage() {
  return <MarketingPage pageKey="changelog" />;
}
