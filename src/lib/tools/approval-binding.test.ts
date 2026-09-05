import { describe, expect, it } from "vitest";
import {
  approvalMaterialBindingSha256,
  evaluateApprovalBinding,
} from "@/lib/tools/approval-binding";

const TARGET_A = "2".repeat(64);
const TARGET_B = "4".repeat(64);
const INPUT = "3".repeat(64);

describe("approval material binding", () => {
  it("accepts only the exact reviewed target and input", () => {
    const approved = approvalMaterialBindingSha256({ targetSha256: TARGET_A, inputSha256: INPUT });
    expect(evaluateApprovalBinding({
      approvedBindingSha256: approved,
      requestedBindingSha256: approved,
    })).toEqual({ accepted: true, reason: "exact_binding" });

    expect(evaluateApprovalBinding({
      approvedBindingSha256: approved,
      requestedBindingSha256: approvalMaterialBindingSha256({ targetSha256: TARGET_B, inputSha256: INPUT }),
    })).toEqual({ accepted: false, reason: "material_binding_changed" });
  });

  it("rejects malformed or non-canonical digests", () => {
    expect(() => evaluateApprovalBinding({
      approvedBindingSha256: "A".repeat(64),
      requestedBindingSha256: "a".repeat(64),
    })).toThrow(/canonical lowercase SHA-256/);
    expect(() => approvalMaterialBindingSha256({
      targetSha256: "short",
      inputSha256: INPUT,
    })).toThrow(/SHA-256/);
  });
});
