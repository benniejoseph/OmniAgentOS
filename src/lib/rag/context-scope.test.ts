import { describe, expect, it } from "vitest";

import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  CONTEXT_SCOPE_POLICIES,
  contextScopeMemoryMode,
  contextScopeUsesThreadHistory,
  getContextScopePolicy,
} from "@/lib/rag/context-scope";

describe("context scope policy", () => {
  it("defines every P4.2 scope exactly once", () => {
    expect(CONTEXT_SCOPE_POLICIES.map((policy) => policy.id)).toEqual(
      CONTEXT_SCOPE_IDS,
    );
    expect(new Set(CONTEXT_SCOPE_IDS).size).toBe(CONTEXT_SCOPE_IDS.length);
  });

  it("keeps automatic personal and shared scopes authority-held", () => {
    for (const scopeId of [
      "mission",
      "project",
      "workspace",
      "personal",
    ] as const) {
      expect(getContextScopePolicy(scopeId).state).toBe("authority_held");
      expect(() => assertContextScopeRequest(scopeId, false)).toThrow(/held/i);
    }
  });

  it("maps active scopes without widening durable context", () => {
    expect(contextScopeMemoryMode("none")).toBe("session");
    expect(contextScopeMemoryMode("current_turn")).toBe("session");
    expect(contextScopeMemoryMode("session")).toBe("session");
    expect(contextScopeMemoryMode("agent_private")).toBe("all");
    expect(contextScopeMemoryMode("explicit_selection")).toBe("all");
    expect(contextScopeUsesThreadHistory("none")).toBe(false);
    expect(contextScopeUsesThreadHistory("current_turn")).toBe(false);
    expect(contextScopeUsesThreadHistory("session")).toBe(true);
    expect(contextScopeUsesThreadHistory("agent_private")).toBe(true);
    expect(contextScopeUsesThreadHistory("explicit_selection")).toBe(true);
  });

  it("activates exact agent-private durable context without a selection", () => {
    expect(assertContextScopeRequest("agent_private", false)).toMatchObject({
      state: "active",
      durableContext: "agent_private",
      requiresSelection: false,
    });
    expect(() => assertContextScopeRequest("agent_private", true)).toThrow(
      /requires the explicit-selection scope/i,
    );
  });

  it("binds reviewed selections only to explicit-selection scope", () => {
    expect(assertContextScopeRequest("explicit_selection", true).state).toBe(
      "active",
    );
    expect(() => assertContextScopeRequest("explicit_selection", false)).toThrow(
      /requires a reviewed context selection/i,
    );
    expect(() => assertContextScopeRequest("session", true)).toThrow(
      /requires the explicit-selection scope/i,
    );
  });
});
