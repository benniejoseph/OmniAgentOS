import type { Metadata } from "next";
import { LandingPage } from "@/components/marketing/landing-page";

export const metadata: Metadata = {
  title: "Asael — Private AI Agent Arsenal",
  description:
    "Plan, supervise, approve, and verify private AI agent work with durable workflows, memory, and evidence.",
};

export default function Home() {
  return <LandingPage />;
}
