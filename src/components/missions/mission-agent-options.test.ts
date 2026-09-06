import { describe, expect, it } from "vitest";

import { missionAgentOptions } from "@/components/missions/mission-workspace";

describe("P7.2 Mission Agent identity", () => {
  it("keeps the central persona in Mission assignment options", () => {
    expect(missionAgentOptions({
      builtIns: [{
        id: "scout",
        name: "Scout",
        role: "Research",
        persona: {
          charter: "Find exact evidence.",
          voice: "Precise and evidence-led.",
          visualIdentity: "Blue trailfinder.",
          allowedDomains: ["Research", "Evidence review"],
          escalationBehavior: "Escalate conflicting evidence.",
          successMeasures: ["Claims cite supplied evidence."],
        },
      }],
    })).toEqual([expect.objectContaining({
      id: "scout",
      name: "Scout",
      role: "Research",
      selectable: true,
      voice: "Precise and evidence-led.",
      allowedDomains: ["Research", "Evidence review"],
      successMeasures: ["Claims cite supplied evidence."],
    })]);
  });
});
