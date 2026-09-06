import { describe, expect, it } from "vitest";

import {
  DEFAULT_CUSTOM_AGENT_PERSONA,
  parseAgentPersonaV1,
} from "@/lib/agents/persona";

describe("agent persona v1", () => {
  it("parses the complete default behavioral identity", () => {
    expect(parseAgentPersonaV1(undefined)).toEqual(DEFAULT_CUSTOM_AGENT_PERSONA);
  });

  it("rejects duplicate domains and unknown authority-like fields", () => {
    expect(() => parseAgentPersonaV1({
      ...DEFAULT_CUSTOM_AGENT_PERSONA,
      allowedDomains: ["Research", "research"],
    })).toThrow("unique");
    expect(() => parseAgentPersonaV1({
      ...DEFAULT_CUSTOM_AGENT_PERSONA,
      toolGrantIds: ["web.search"],
    })).toThrow();
  });
});
