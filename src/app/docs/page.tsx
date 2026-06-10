import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing-page";

export const metadata: Metadata = {
  title: "Docs",
};

export default function DocsPage() {
  return <MarketingPage pageKey="docs" />;
}
