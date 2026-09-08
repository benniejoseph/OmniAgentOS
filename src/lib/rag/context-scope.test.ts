import { describe, expect, it } from "vitest";

import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  CONTEXT_SCOPE_POLICIES,
  contextScopeMemoryMode,
  contextScopeUsesThreadHistory,
} from "@/lib/rag/context-scope";

describe("context scope policy", () => {
  it("defines every P4.2 scope exactly once", () => {
    expect(CONTEXT_SCOPE_POLICIES.map((policy) => policy.id)).toEqual(
      CONTEXT_SCOPE_IDS,
    );
    expect(new Set(CONTEXT_SCOPE_IDS).size).toBe(CONTEXT_SCOPE_IDS.length);
  });

  it("admits automatic personal scope only as a consent-gated runtime policy", () => {
    expect(assertContextScopeRequest("personal", false)).toMatchObject({
      state: "active",
      durableContext: "personal",
      requiresSelection: false,
    });
    expect(() => assertContextScopeRequest("personal", true)).toThrow(
      /requires the explicit-selection scope/i,
    );
  });

  it("maps active scopes without widening durable context", () => {
    expect(contextScopeMemoryMode("none")).toBe("session");
    expect(contextScopeMemoryMode("current_turn")).toBe("session");
    expect(contextScopeMemoryMode("session")).toBe("session");
    expect(contextScopeMemoryMode("agent_private")).toBe("all");
    expect(contextScopeMemoryMode("mission")).toBe("all");
    expect(contextScopeMemoryMode("project")).toBe("all");
    expect(contextScopeMemoryMode("workspace")).toBe("all");
    expect(contextScopeMemoryMode("personal")).toBe("all");
    expect(contextScopeMemoryMode("explicit_selection")).toBe("all");
    expect(contextScopeUsesThreadHistory("none")).toBe(false);
    expect(contextScopeUsesThreadHistory("current_turn")).toBe(false);
    expect(contextScopeUsesThreadHistory("session")).toBe(true);
    expect(contextScopeUsesThreadHistory("agent_private")).toBe(true);
    expect(contextScopeUsesThreadHistory("mission")).toBe(true);
    expect(contextScopeUsesThreadHistory("project")).toBe(true);
    expect(contextScopeUsesThreadHistory("workspace")).toBe(true);
    expect(contextScopeUsesThreadHistory("personal")).toBe(true);
    expect(contextScopeUsesThreadHistory("explicit_selection")).toBe(true);
  });

  it("activates only explicitly selected canonical shared scopes", () => {
    expect(assertContextScopeRequest("mission", false)).toMatchObject({
      state: "active",
      durableContext: "project",
      requiresSelection: false,
    });
    expect(assertContextScopeRequest("project", false)).toMatchObject({
      state: "active",
      durableContext: "project",
      requiresSelection: false,
    });
    expect(assertContextScopeRequest("workspace", false)).toMatchObject({
      state: "active",
      durableContext: "workspace",
      requiresSelection: false,
    });
    expect(() => assertContextScopeRequest("project", true)).toThrow(
      /requires the explicit-selection scope/i,
    );
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
