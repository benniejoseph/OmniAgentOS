import type { Metadata } from "next";
import { LandingPage } from "@/components/marketing/landing-page";

export const metadata: Metadata = {
  title: "Enterprise AI Agent Orchestration",
};

export default function Home() {
  return <LandingPage />;
}
