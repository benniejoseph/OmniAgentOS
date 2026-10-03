import { LandingHero } from "./landing-hero";
import { CapabilityGrid, OperatingLoop, ProductFacts } from "./landing-operating-story";
import { MarketingFaq, ProductWalkthrough, TrustControls } from "./landing-proof";
import { PrivateWorkspaceCta } from "./landing-cta";
import { PublicFrame } from "./public-frame";

export function LandingPage() {
  return <PublicFrame><LandingHero /><ProductFacts /><OperatingLoop /><CapabilityGrid />
    <ProductWalkthrough /><TrustControls /><MarketingFaq /><PrivateWorkspaceCta /></PublicFrame>;
}
