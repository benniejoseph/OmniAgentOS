import { LandingHero } from "@/components/marketing/landing-hero";
import {
  CapabilityGrid,
  OperatingLoop,
  ProductFacts,
} from "@/components/marketing/landing-operating-story";
import {
  MarketingFaq,
  ProductWalkthrough,
  TrustControls,
} from "@/components/marketing/landing-proof";
import { PrivateWorkspaceCta } from "@/components/marketing/landing-cta";
import { PublicHeader } from "@/components/marketing/public-header";

export function LandingPage() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-md bg-primary px-4 py-3 font-semibold text-primary-ink focus:not-sr-only"
      >
        Skip to content
      </a>
      <PublicHeader />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen overflow-hidden bg-background text-foreground"
      >
        <LandingHero />
        <ProductFacts />
        <OperatingLoop />
        <CapabilityGrid />
        <ProductWalkthrough />
        <TrustControls />
        <MarketingFaq />
        <PrivateWorkspaceCta />
      </main>
    </>
  );
}
