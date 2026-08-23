import type { Metadata } from "next";
import { LandingPage } from "@/components/marketing/landing-page";

export const metadata: Metadata = {
  title: "Governed AI Agent Operations",
  description:
    "Plan, supervise, approve, and verify private AI agent work with durable workflows, memory, and evidence.",
};

export default function Home() {
  return <LandingPage />;
}
