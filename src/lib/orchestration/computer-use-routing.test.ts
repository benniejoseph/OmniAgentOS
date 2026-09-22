import { describe, expect, it } from "vitest";
import {
  modelAssignmentScopeForAgent,
} from "@/lib/orchestration/computer-use-routing";

describe("Computer Use model routing", () => {
  it("selects the configurable Computer Use route without changing agent identity", () => {
    expect(modelAssignmentScopeForAgent("atlas", true)).toBe("computer_use");
    expect(modelAssignmentScopeForAgent("forge", true)).toBe("computer_use");
    expect(modelAssignmentScopeForAgent("forge", false)).toBe("code_builder");
    expect(modelAssignmentScopeForAgent("sentinel", false)).toBe("verifier");
    expect(modelAssignmentScopeForAgent("meridian", false)).toBe("market_research");
    expect(modelAssignmentScopeForAgent("mnemosyne", false)).toBe("memory");
    expect(modelAssignmentScopeForAgent("scout", false)).toBe("council");
    expect(modelAssignmentScopeForAgent("atlas", false)).toBe("main_agent");
  });
});
