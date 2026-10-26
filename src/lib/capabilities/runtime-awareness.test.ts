import { describe, expect, it } from "vitest";
import { formatRuntimeCapabilityAwareness } from "@/lib/capabilities/runtime-awareness";
import { conversationControlToolPreferences } from "@/lib/capabilities/conversation-controls";
import { loadProgressiveAgentTools } from "@/lib/capabilities/toolbox";
import { getGovernedTools } from "@/lib/tools/registry";

describe("runtime capability awareness and source development", () => {
  it("does not confuse evidence already collected with admitted future search", () => {
    const context = formatRuntimeCapabilityAwareness({ tools: [{ id: "web.read" }], hasWebEvidence: true });
    expect(context).toContain("Direct public web search: not admitted; URL reading: admitted; tracked research: not admitted");
    expect(context).toContain("Public source material supplied for this request: yes");
    expect(context).toContain("commands: not admitted");
  });
  it("describes actual selected Mac and source capabilities without invented health", () => {
    const context = formatRuntimeCapabilityAwareness({ tools: ["local.macos.command.run", "app.capabilities.inspect", "app.projects.builder.file.read"].map(id => ({ id })), hasWebEvidence: false, computerUseTarget: "local_macos" });
    expect(context).toContain("Selected computer target: local_macos. Mac observation: not admitted");
    expect(context).toContain("approved-workspace commands: admitted");
    expect(context).toContain("source editing: not admitted");
    expect(context).toContain("does not enable itself");
  });
  it.each(["Improve yourself by fixing a bug in Asael", "self development: inspect your code and implement a change", "Refactor this repository"]) ("discovers a usable source/change/verification path for %s", async query => {
    const preferences = conversationControlToolPreferences(query);
    const expected = ["app.capabilities.inspect", "app.projects.list", "app.projects.builder.show", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.checkpoint.create", "app.projects.builder.command.run", "app.projects.builder.verification.run"];
    expect(preferences).toEqual(expect.arrayContaining(expected));
    const toolbox = await loadProgressiveAgentTools({ query }, {
      listNative: getGovernedTools,
      search: async () => ({ capabilities: [], query, total: 0, limit: 6, hasMore: false }),
      resolveMcp: async () => null, resolveOpenApi: async () => null,
    });
    expect(toolbox.definitions.map(tool => tool.id)).toEqual(expect.arrayContaining(expected));
    expect(toolbox.definitions.length).toBeLessThanOrEqual(32);
  });
  it("does not widen a restricted agent or computer selection for self-development", async () => {
    const toolbox = await loadProgressiveAgentTools({ query: "Improve yourself and deploy Asael", preferredToolIds: ["app.capabilities.inspect", "web.read"], excludeToolIds: ["local.macos.command.run"] }, {
      listNative: getGovernedTools,
      search: async () => ({ capabilities: [], query: "", total: 0, limit: 6, hasMore: false }),
      resolveMcp: async () => null, resolveOpenApi: async () => null,
    });
    expect(toolbox.definitions.map(tool => tool.id).sort()).toEqual(["app.capabilities.inspect", "web.read"]);
  });
  it.each([
    "Check the status of the current pending task related to the persona and see what it's waiting for or what the next step is.",
    "I think the task is stuck somewhere, maybe you need to give it a nudge.",
    "Can you check what is it waiting for or what is it doing?",
    "Check the latest conversation; it stopped progressing.",
    "Resume it.",
  ])("admits the real executor readers for a captured diagnostic follow-up: %s", async query => {
    const toolbox = await loadProgressiveAgentTools({ query }, {
      listNative: getGovernedTools,
      search: async () => ({ capabilities: [], query, total: 0, limit: 6, hasMore: false }),
      resolveMcp: async () => null, resolveOpenApi: async () => null,
    });
    expect(toolbox.definitions.map(tool => tool.id)).toEqual(expect.arrayContaining([
      "app.runs.list", "app.runs.show", "app.workflows.list", "app.workflows.show", "missions.list", "mission.show",
    ]));
    expect(toolbox.definitions.length).toBeLessThanOrEqual(32);
    if (query.includes("nudge")) expect(toolbox.definitions.map(tool => tool.id)).toContain("app.workflows.signal");
  });
  it("diagnostic discovery preserves a restricted read-only tool grant", async () => {
    const toolbox = await loadProgressiveAgentTools({ query: "My task is stuck; resume it", preferredToolIds: ["app.runs.show", "app.workflows.show"] }, {
      listNative: getGovernedTools,
      search: async () => ({ capabilities: [], query: "", total: 0, limit: 6, hasMore: false }),
      resolveMcp: async () => null, resolveOpenApi: async () => null,
    });
    expect(toolbox.definitions.map(tool => tool.id).sort()).toEqual(["app.runs.show", "app.workflows.show"]);
    const guidance = formatRuntimeCapabilityAwareness({ tools: toolbox.definitions, hasWebEvidence: false });
    expect(guidance).toContain("governed workflow controls not admitted");
    expect(guidance).toContain("Paused is not awaiting clarification");
  });
});
