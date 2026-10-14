import { describe, expect, it } from "vitest";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ToolDefinition } from "@/lib/tools/types";
import { responsibilityToolAuthoritySha256 } from "./tool-authority";

const tool = FIRST_PARTY_APP_TOOLS.find((item) => item.id === "app.work_items.show")!;

describe("Responsibility tool authority", () => {
  it("excludes only top-level display wording from the actual Work tool", () => {
    const hash = responsibilityToolAuthoritySha256(tool);
    expect(responsibilityToolAuthoritySha256({ ...tool, name: "Commitment details", description: "Clearer display copy." })).toBe(hash);
    expect(hash).not.toBe(canonicalJsonSha256(tool));
  });

  it.each<[string, Partial<ToolDefinition>]>([
    ["identity", { id: "app.work_items.list" }],
    ["category", { category: "connector" }],
    ["status", { status: "planned" }],
    ["risk", { riskLevel: 1 }],
    ["approval", { approvalRequired: true }],
    ["effect", { operationClass: "mutation" }],
    ["reversibility", { reversible: !tool.reversible }],
    ["dry run", { dryRunSupported: !tool.dryRunSupported }],
    ["reviewed connector contract", { approvalFingerprint: "new-fingerprint" }],
    ["input schema", { inputSchema: { ...tool.inputSchema, required: ["differentInput"] } }],
    ["schema description", { inputSchema: { ...tool.inputSchema, description: "Schema semantics remain pinned" } }],
    ["description-named input", { inputSchema: { type: "object", properties: { description: { type: "string" } } } }],
  ])("pins %s", (_label, patch) => {
    expect(responsibilityToolAuthoritySha256({ ...tool, ...patch })).not.toBe(responsibilityToolAuthoritySha256(tool));
  });

  it("fails closed for future operational fields instead of silently dropping them", () => {
    const future = { ...tool, executionContractVersion: 2 };
    expect(responsibilityToolAuthoritySha256(future)).not.toBe(responsibilityToolAuthoritySha256(tool));
  });
});
