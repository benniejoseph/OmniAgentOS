import type { Metadata } from "next";

import { MarketResearchWorkspace } from "@/components/market-research/market-research-workspace";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return <MarketResearchWorkspace />;
}
