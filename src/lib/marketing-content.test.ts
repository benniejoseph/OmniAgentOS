import { describe, expect, it } from "vitest";
import {
  homepageCapabilities,
  marketingActions,
  marketingFaq,
  marketingNav,
  operatingLoop,
  productFacts,
  trustControls,
  walkthroughSteps,
} from "@/lib/marketing-content";

describe("owner-only marketing content", () => {
  it("offers login as the only account-entry action", () => {
    expect(marketingNav.map((item) => item.label)).toEqual([
      "Platform",
      "Solutions",
      "Security",
      "Demo",
      "Docs",
    ]);
    expect(marketingActions).toEqual({
      signIn: { href: "/login", label: "Sign in" },
      demo: { href: "/demo", label: "Explore sample workspace" },
    });
  });

  it("describes the approved factual operating story", () => {
    expect(productFacts).toHaveLength(4);
    expect(operatingLoop.map((step) => step.title)).toEqual([
      "Define",
      "Execute",
      "Approve",
      "Verify",
    ]);
    expect(homepageCapabilities).toHaveLength(6);
    expect(walkthroughSteps.map((step) => step.label)).toEqual([
      "Command",
      "Workflow",
      "Approval",
      "Evidence",
    ]);
    expect(trustControls).toHaveLength(5);
    expect(marketingFaq).toHaveLength(4);
  });
});
