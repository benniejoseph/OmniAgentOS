import { describe, expect, it } from "vitest";
import {
  findAppBuilderSentinelReview,
  hasPassingAppBuilderSentinelReview,
  parseAppBuilderSentinelVerdict,
} from "@/lib/app-builder/sentinel-review";

const verification = {
  id: `app_build_verification_${"a".repeat(48)}`,
  checkpointId: `app_build_checkpoint_${"b".repeat(48)}`,
  workspaceSha256: "c".repeat(64),
};

describe("App Builder Sentinel review", () => {
  it("accepts only an explicit opening PASS verdict", () => {
    expect(parseAppBuilderSentinelVerdict("## PASS — the objective is demonstrated.")).toBe("passed");
    expect(parseAppBuilderSentinelVerdict("**PASS**\nEvidence follows.")).toBe("passed");
    expect(parseAppBuilderSentinelVerdict("## BLOCK — missing objective evidence.")).toBe("blocked");
  });

  it("fails closed when the response has no unambiguous opening verdict", () => {
    expect(parseAppBuilderSentinelVerdict("The checks passed, but the objective is not proven.")).toBe("blocked");
    expect(parseAppBuilderSentinelVerdict("")).toBe("blocked");
  });

  it("requires a passing review bound to the exact verification, checkpoint, and workspace", () => {
    const activity = [{
      eventType: "app_builder.sentinel.reviewed",
      detail: { ...verification, verificationId: verification.id, verdict: "passed" },
    }];
    expect(findAppBuilderSentinelReview(activity, verification)).toBe(activity[0]);
    expect(hasPassingAppBuilderSentinelReview(activity, verification)).toBe(true);
    expect(hasPassingAppBuilderSentinelReview(activity, { ...verification, workspaceSha256: "d".repeat(64) })).toBe(false);
  });

  it("does not treat deterministic checks or a blocked review as approval", () => {
    expect(hasPassingAppBuilderSentinelReview([{ eventType: "app_builder.verification.completed", detail: { status: "passed" } }], verification)).toBe(false);
    expect(hasPassingAppBuilderSentinelReview([{
      eventType: "app_builder.sentinel.reviewed",
      detail: { ...verification, verificationId: verification.id, verdict: "blocked" },
    }], verification)).toBe(false);
  });
});
