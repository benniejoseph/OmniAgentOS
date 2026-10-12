import type { Metadata } from "next";
import { LandingPage } from "@/components/marketing/landing-page";

export const metadata: Metadata = {
  title: "Asael — Your personal AI partner",
  description:
    "Bring your projects, context and commitments together with a personal AI partner for real work.",
};

export default function Home() {
  return <LandingPage />;
}
