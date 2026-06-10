import { describe, expect, it } from "vitest";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import type { ToolDefinition } from "@/lib/tools/types";

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    id: "test.tool",
    name: "Test Tool",
    description: "A test tool.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("evaluateToolPolicy", () => {
  it("auto-allows risk 0 read-only tools", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 0 }) });
    expect(decision).toMatchObject({ allowed: true, approvalRequired: false, blocked: false });
  });

  it("auto-allows risk 1 reversible tools", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 1 }) });
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(false);
  });

  it("requires approval for risk 2 tools", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 2 }) });
    expect(decision).toMatchObject({ allowed: false, approvalRequired: true, blocked: false });
  });

  it("allows risk 2 tools once approved", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 2 }), approved: true });
    expect(decision.allowed).toBe(true);
  });

  it("requires approval when approvalRequired is set regardless of risk", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 0, approvalRequired: true }) });
    expect(decision.allowed).toBe(false);
    expect(decision.approvalRequired).toBe(true);
  });

  it("blocks risk 3 tools even when approved", () => {
    const decision = evaluateToolPolicy({ tool: tool({ riskLevel: 3 }), approved: true });
    expect(decision).toMatchObject({ allowed: false, blocked: true });
  });

  it("blocks inactive tools", () => {
    const decision = evaluateToolPolicy({ tool: tool({ status: "planned" }) });
    expect(decision.blocked).toBe(true);
    expect(decision.allowed).toBe(false);
  });
});
