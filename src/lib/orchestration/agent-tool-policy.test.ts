import { describe, expect, it } from "vitest";

import { resolveAgentToolPolicy } from "@/lib/orchestration/agent-tool-policy";

describe("Agent tool policy", () => {
  it("maps always-for-writes to risk-bearing tools without gating reads", () => {
    expect(resolveAgentToolPolicy({
      allowedToolIds: ["moltbook.feed.read", "moltbook.post.vote"],
      approvalPolicy: "always",
      autonomy: "governed",
    })).toEqual({
      allowedToolIds: ["moltbook.feed.read", "moltbook.post.vote"],
      readOnly: false,
      forceApproval: false,
      forceApprovalAboveRisk: 0,
    });
  });

  it("keeps risk-based execution and read-only profiles distinct", () => {
    expect(resolveAgentToolPolicy({
      allowedToolIds: ["memory.search"],
      approvalPolicy: "risk_based",
      autonomy: "governed",
    })).toEqual({
      allowedToolIds: ["memory.search"],
      readOnly: false,
      forceApproval: false,
    });
    expect(resolveAgentToolPolicy({
      allowedToolIds: ["memory.search"],
      approvalPolicy: "read_only",
      autonomy: "execute",
    })).toEqual({
      allowedToolIds: ["memory.search"],
      readOnly: true,
      forceApproval: false,
    });
  });

  it("keeps assist-mode Agents read only", () => {
    expect(resolveAgentToolPolicy({
      allowedToolIds: ["memory.search"],
      approvalPolicy: "risk_based",
      autonomy: "assist",
    })).toMatchObject({ readOnly: true, forceApproval: false });
  });
});
