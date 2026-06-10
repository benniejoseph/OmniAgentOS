import type { Metadata } from "next";
import { PublicHeader } from "@/components/marketing/public-header";
import { OnboardingConsole } from "@/components/onboarding/onboarding-console";

export const metadata: Metadata = {
  title: "Onboarding",
};

export default function OnboardingPage() {
  return (
    <>
      <PublicHeader />
      <OnboardingConsole />
    </>
  );
}
