import { describe, expect, it, vi } from "vitest";
import {
  AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT,
  AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT,
  AGENT_MODEL_TOOL_LIMIT,
  AGENT_TOOL_SCHEMA_MAX_BYTES,
  AGENT_TOOL_SCHEMA_RUN_MAX_BYTES,
  applyToolSchemaBudget,
  capabilityFunctionName,
  composeCapabilitySearchQuery,
  hasRequiredNativeToolDependencies,
  loadProgressiveAgentTools,
} from "@/lib/capabilities/toolbox";
import { CAPABILITY_MAX_QUERY_LENGTH } from "@/lib/capabilities/types";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";
import type { ToolDefinition } from "@/lib/tools/types";
import { getGovernedTools } from "@/lib/tools/registry";
import { dynamicDelegationCapabilityQueryPrefix } from "@/lib/delegation/runtime-policy";

describe("progressive agent toolbox", () => {
  const researchTools = ["app.research.start", "web.search", "web.read"];

  it.each([
    "Research cheaper offers for Palm Meadows, check in 19 October and check out 21 October; compare full prices and cancellation terms.",
    "can you enable live web search and check it app.research.start",
  ])("admits a hotel research follow-up with both live-source prerequisites: %s", async query => {
    const result = await loadProgressiveAgentTools({ query }, governedDependencies());
    expect(result.definitions.map(item => item.id)).toEqual(expect.arrayContaining(researchTools));
    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.schemaBytes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_RUN_MAX_BYTES);
  });

  it.each(["web.search", "web.read"])("withholds durable research when %s is explicitly excluded", async missing => {
    const result = await loadProgressiveAgentTools({
      query: "app.research.start for Palm Meadows cheaper room offers",
      excludeToolIds: [missing],
    }, governedDependencies());
    const ids = result.definitions.map(item => item.id);
    expect(ids).not.toContain("app.research.start");
    expect(ids).not.toContain(missing);
    expect(ids).toContain(missing === "web.search" ? "web.read" : "web.search");
  });

  it.each([
    ["app.research.start"],
    ["app.research.start", "web.search"],
    ["app.research.start", "web.read"],
  ])("does not expand a custom research allowlist: %j", async (...allowed) => {
    const result = await loadProgressiveAgentTools({ query: "Start research", preferredToolIds: allowed }, governedDependencies());
    expect(result.definitions.map(item => item.id)).toEqual(allowed.filter(id => id !== "app.research.start"));
  });

  it("does not advertise durable research if its last prerequisite cannot fit the schema budget", () => {
    const definitions = researchTools.map(governedTool);
    const allBytes = definitions.reduce((total, item) => total + schemaBytes(item), 0);
    expect(applyToolSchemaBudget(definitions, { perRunBytes: allBytes }).definitions.map(item => item.id)).toEqual(researchTools);
    const constrained = applyToolSchemaBudget(definitions, { perRunBytes: allBytes - 1 });
    expect(constrained.definitions.map(item => item.id)).toEqual(["web.search", "web.read"]);
    expect(constrained.omittedToolIds).toEqual(["app.research.start"]);
    expect(constrained.schemaBytes).toBe(schemaBytes(definitions[1]) + schemaBytes(definitions[2]));
  });

  it.each([29, 30, 31])("never splits the research bundle at the model tool-count boundary (%s reserved tools)", async reservedCount => {
    const reserved = Array.from({ length: reservedCount }, (_, index) => tool({ id: `native-priority-${index}` }));
    const result = await loadProgressiveAgentTools({
      query: "app.research.start", priorityNativeToolIds: reserved.map(item => item.id),
    }, { ...governedDependencies(), listNative: () => [...reserved, ...researchTools.map(governedTool)] });
    const ids = result.definitions.map(item => item.id);
    expect(ids.slice(0, reservedCount)).toEqual(reserved.map(item => item.id));
    expect(ids.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    if (reservedCount === 29) expect(ids).toEqual(expect.arrayContaining(researchTools));
    else expect(ids).not.toContain("app.research.start");
  });

  it("retains direct search when a research dependency has an oversized contract", () => {
    const result = applyToolSchemaBudget(researchTools.map(id => id === "web.read"
      ? { ...governedTool(id), inputSchema: { description: "x".repeat(AGENT_TOOL_SCHEMA_MAX_BYTES) } }
      : governedTool(id)));
    expect(result.definitions.map(item => item.id)).toEqual(["web.search"]);
    expect(result.omittedToolIds).toEqual(["app.research.start", "web.read"]);
  });

  it("requires research dependencies after a later policy filter too", () => {
    expect(hasRequiredNativeToolDependencies("app.research.start", new Set(researchTools))).toBe(true);
    expect(hasRequiredNativeToolDependencies("app.research.start", new Set(["app.research.start", "web.search"]))).toBe(false);
    expect(hasRequiredNativeToolDependencies("web.search", new Set(["web.search"]))).toBe(true);
    expect(applyToolSchemaBudget([governedTool("app.research.start")]).definitions).toEqual([]);
  });

  const macControls = [
    "local.macos.observe", "local.macos.list_apps", "local.macos.activate_app", "local.macos.open_url",
    "local.macos.press", "local.macos.click", "local.macos.type", "local.macos.key", "local.macos.scroll",
    "local.macos.open_asael",
  ];
  const phoneControls = [
    "local.android.observe", "local.android.list_apps", "local.android.open_app", "local.android.press",
    "local.android.tap", "local.android.type", "local.android.scroll", "local.android.swipe",
    "local.android.back", "local.android.home",
  ];

  it.each([
    "Open YouTube and play the first video from 2819's channel.",
    "youtube channel video newest upload",
  ])("reserves the admitted Mac interaction set despite wording and connector noise: %s", async query => {
    const descriptors = Array.from({ length: AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT }, (_, index) => descriptor(`mcp:noise:read-${index}`));
    const dependencies = {
      ...governedDependencies(descriptors),
      resolveMcp: vi.fn(async (id: string) => tool({ id, category: "mcp", inputSchema: {
        type: "object", properties: { value: { type: "string", description: "x".repeat(11_000) } },
      } })),
    };
    const result = await loadProgressiveAgentTools({ query,
      priorityNativeToolIds: macControls,
      excludeToolIds: [...phoneControls, "local.macos.command.run"],
      requiredReadToolIds: ["app.library.show"],
    }, dependencies);
    expect(result.definitions.slice(0, macControls.length).map(tool => tool.id)).toEqual(macControls);
    for (const id of macControls) expect(result.definitions.find(tool => tool.id === id)).toEqual(governedTool(id));
    expect(result.definitions.map(tool => tool.id)).toContain("app.library.show");
    expect(result.definitions.some(tool => tool.id.startsWith("mcp:"))).toBe(true);
    expect(result.definitions.some(tool => tool.id.startsWith("local.android."))).toBe(false);
    expect(result.definitions.map(tool => tool.id)).not.toContain("local.macos.command.run");
    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.schemaBytes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_RUN_MAX_BYTES);
  });

  it("device priorities never widen a scoped Agent allowlist", async () => {
    const result = await loadProgressiveAgentTools({
      query: "Open YouTube and play the first video from 2819's channel.",
      priorityNativeToolIds: macControls,
      preferredToolIds: ["local.macos.open_url", "web.read"],
    }, governedDependencies());
    expect(result.definitions.map(tool => tool.id)).toEqual(["local.macos.open_url", "web.read"]);
  });

  it.each(["all", "partial"])("device priorities preserve explicit capability exclusions (%s)", async scenario => {
    const excluded = scenario === "partial" ? ["local.macos.type", "local.macos.key"] : macControls;
    const result = await loadProgressiveAgentTools({ query: "Open Chrome and type a search",
      priorityNativeToolIds: macControls, excludeToolIds: excluded,
    }, governedDependencies());
    for (const id of excluded) expect(result.definitions.map(tool => tool.id)).not.toContain(id);
    if (scenario === "partial") expect(result.definitions.map(tool => tool.id)).toContain("local.macos.observe");
  });

  it("reserves only the admitted phone controls when Mac tools are excluded", async () => {
    const result = await loadProgressiveAgentTools({ query: "Open YouTube and play the first video",
      priorityNativeToolIds: phoneControls, excludeToolIds: [...macControls, "local.macos.command.run"],
    }, governedDependencies());
    expect(result.definitions.slice(0, phoneControls.length).map(tool => tool.id)).toEqual(phoneControls);
    expect(result.definitions.some(tool => tool.id.startsWith("local.macos."))).toBe(false);
    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
  });

  it("native priority cannot admit inactive, risk-three, external or oversized definitions", async () => {
    const definitions = [
      tool({ id: "local.macos.observe", inputSchema: { type: "object", description: "x".repeat(AGENT_TOOL_SCHEMA_MAX_BYTES) } }),
      tool({ id: "local.macos.click", riskLevel: 3 }),
      tool({ id: "local.macos.key", status: "planned" }),
      tool({ id: "local.macos.type" }),
    ];
    const result = await loadProgressiveAgentTools({
      priorityNativeToolIds: [...macControls, "mcp:unrequested:execute"],
    }, { ...governedDependencies(), listNative: () => definitions });
    expect(result.definitions.map(tool => tool.id)).toEqual(["local.macos.type"]);
    expect(result.omittedToolIds).toContain("local.macos.observe");
  });

  it("reserves the explicit attached-source reader independently of wording and semantic query truncation", async () => {
    const prompt = "Continue the existing project SIMULATION AV-1013-R1 — Aster Vale Field Services using the attached original brief, kickoff notes and latest change note. Reconcile its current commitments into the saved responsible-person, calendar-deadline and task-dependency fields. Update the existing tasks without duplicating them, preserve their acceptance criteria, and distinguish requested, scheduled or reported work from verified delivery. Use the latest source when it explicitly revises an earlier commitment; leave unknown time zones and unresolved external conditions explicit. Correct the saved project brief from these sources, then read back the saved tasks and current summary. Tell me what changed, what needs attention next, and what cannot yet be verified. Do not send messages or start execution workflows.";
    const descriptors = Array.from({ length: AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT }, (_, index) => descriptor(`mcp:workspace:search-${index}`));
    for (const query of [prompt, composeCapabilitySearchQuery(prompt), composeCapabilitySearchQuery("update existing project commitments ".repeat(12), prompt)]) {
      const result = await loadProgressiveAgentTools({ tenantId: "tenant-private", query,
        requiredReadToolIds: ["app.library.show"],
      }, governedDependencies(descriptors));
      expect(result.definitions[0].id).toBe("app.library.show");
      expect(result.definitions.find(item => item.id === "app.library.show")).toEqual(governedTool("app.library.show"));
      expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
      expect(result.schemaBytes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_RUN_MAX_BYTES);
    }
  });

  it("never widens an Agent allowlist or a current exclusion for an attached source", async () => {
    for (const scope of [
      { preferredToolIds: ["app.projects.show", "app.work_items.show"] },
      { excludeToolIds: ["app.library.show"] },
    ]) {
      const result = await loadProgressiveAgentTools({ query: "Read the attached original brief", requiredReadToolIds: ["app.library.show"], ...scope }, governedDependencies([]));
      expect(result.definitions.map(item => item.id)).not.toContain("app.library.show");
    }
  });

  it("discovers public source reading while preserving custom-agent tool allowlists", async () => {
    const dependencies = {
      listNative: getGovernedTools,
      search: vi.fn(async () => ({ capabilities: [], query: "", total: 0, limit: 50, hasMore: false })),
      resolveMcp: vi.fn(async () => null),
      resolveOpenApi: vi.fn(async () => null),
    };
    const discovered = await loadProgressiveAgentTools({ query: "Research and read public web source URLs" }, dependencies);
    expect(discovered.definitions.map((tool) => tool.id)).toContain("web.read");
    const restricted = await loadProgressiveAgentTools({ query: "Research and read public web source URLs", preferredToolIds: ["web.search"] }, dependencies);
    expect(restricted.definitions.map((tool) => tool.id)).toEqual(["web.search"]);
  });

  it("keeps Google Workspace, document creation, and imported Photos discoverable from Command language", async () => {
    const dependencies = {
      listNative: getGovernedTools,
      search: vi.fn(async () => ({
        capabilities: [],
        query: "",
        total: 0,
        limit: 50,
        hasMore: false,
      })),
      resolveMcp: vi.fn(async () => null),
      resolveOpenApi: vi.fn(async () => null),
    };

    const drive = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "find and edit my Google Drive document" },
      dependencies,
    );
    expect(drive.definitions.map((item) => item.id)).toEqual(expect.arrayContaining([
      "google.drive.search",
      "google.docs.read",
      "google.docs.update",
    ]));

    const mail = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "read my Gmail and send an email" },
      dependencies,
    );
    expect(mail.definitions.map((item) => item.id)).toEqual(expect.arrayContaining([
      "google.gmail.search",
      "google.gmail.read",
      "app.communications.drafts.create",
      "app.communications.deliver",
    ]));

    const photos = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "show my imported Google Photos" },
      dependencies,
    );
    expect(photos.definitions.map((item) => item.id)).toEqual(expect.arrayContaining([
      "app.assets.list",
      "app.assets.show",
    ]));

    const presentation = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "create a polished editable PowerPoint pitch deck presentation" },
      dependencies,
    );
    expect(presentation.definitions.map((item) => item.id)).toContain(
      "app.artifacts.presentations.create",
    );

    const collaborativeDocument = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "create a native Google Doc I can edit with my team" },
      dependencies,
    );
    expect(collaborativeDocument.definitions.map((item) => item.id)).toContain(
      "google.docs.create",
    );
  });

  it("caps model-facing tools while retaining relevant native and external tools", async () => {
    const nativeDefinitions = Array.from({ length: 50 }, (_, index) => tool({
      id: index === 49 ? "app.memory.shared.list" : `app.unrelated.tool-${index}`,
      name: index === 49 ? "List shared memory" : `Unrelated tool ${index}`,
    }));
    const descriptors = Array.from(
      { length: AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT },
      (_, index) => descriptor(`mcp:workspace:search-${index}`),
    );

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "use workspace shared memory" },
      {
        listNative: () => nativeDefinitions,
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: "use workspace shared memory",
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp: vi.fn(async (id) => tool({ id, category: "mcp" })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.definitions.map((item) => item.id))
      .toEqual(expect.arrayContaining(descriptors.map((item) => item.id)));
    expect(result.definitions.map((item) => item.id))
      .toContain("app.memory.shared.list");
  });

  it.each([
    ["a long reconciliation request", [
      "Continue the fictional client project SIMULATION AV-1013-R1 — Aster Vale Field Services using the attached simulation change note.",
      "Your previous attempt updated only two of the five commitments.",
      "Finish reconciling the existing commitments and project summary with the note, preserving their identities and acceptance criteria.",
      "Check what was actually saved before reporting completion.",
      "Do not create duplicate work, invent completion evidence or invent a clock time for a date-only commitment.",
      "Leave client communication as an unsent draft. Tell me what you completed and what still needs my attention.",
    ].join(" ")],
    ["a task deadline change", "Change the deadline on my existing task and check the saved acceptance criteria."],
    ["a project task completion", "Mark the project task complete after reviewing its evidence."],
  ])("keeps canonical reads beside continuity mutations for %s", async (_name, query) => {
    const descriptors = Array.from(
      { length: AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT },
      (_, index) => descriptor(`mcp:workspace:search-${index}`),
    );
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query },
      governedDependencies(descriptors),
    );

    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.definitions.map(item => item.id)).toEqual(expect.arrayContaining([
      "app.projects.list", "app.projects.show", "app.projects.update",
      "app.work_items.show", "app.work_items.update",
      ...descriptors.map(item => item.id),
    ]));
    expect(result.schemaBytes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_RUN_MAX_BYTES);
    for (const id of ["app.projects.show", "app.work_items.show", "app.work_items.update"]) {
      expect(result.definitions.find(item => item.id === id)).toEqual(governedTool(id));
    }
  });

  it("carries the inventory's authorized reader without conversation keyword preferences", async () => {
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "compact paginated inventory" },
      governedDependencies(),
    );

    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.definitions.map(item => item.id)).toEqual(expect.arrayContaining([
      "app.projects.show", "app.work_items.show",
    ]));
  });

  it("does not split an authorized inventory-reader pair at the tool-count boundary", async () => {
    const unrelated = getGovernedTools().filter(item =>
      item.status === "active" && item.riskLevel === 0 &&
      !["app.projects.show", "app.work_items.show", "app.agents.delegate"].includes(item.id)
    ).slice(0, AGENT_MODEL_TOOL_LIMIT - 1);
    const result = await loadProgressiveAgentTools(
      { query: "", preferredToolIds: [...unrelated.map(item => item.id), "app.projects.show", "app.work_items.show"] },
      {
        ...governedDependencies(),
        // All contracts are real; equal read-only scores preserve this boundary.
        listNative: () => [
          ...unrelated,
          governedTool("app.projects.show"), governedTool("app.work_items.show"),
        ],
      },
    );

    const ids = result.definitions.map(item => item.id);
    expect(ids).toHaveLength(AGENT_MODEL_TOOL_LIMIT);
    expect(ids).not.toContain("app.projects.show");
    expect(ids).toContain("app.work_items.show");
  });

  it("preserves explicit inventory-only access without widening its allowlist", async () => {
    const dependencies = governedDependencies();
    const result = await loadProgressiveAgentTools(
      { query: "Update my project task", preferredToolIds: ["app.projects.show", "app.work_items.update"] },
      dependencies,
    );

    expect(result.definitions.map(item => item.id)).toEqual([
      "app.projects.show", "app.work_items.update",
    ]);
    expect(dependencies.search).not.toHaveBeenCalled();
  });

  it.each(["excluded", "inactive", "high-risk", "unavailable"])(
    "does not restore a detailed reader that is %s",
    async restriction => {
      const dependencies = governedDependencies();
      const result = await loadProgressiveAgentTools(
        {
          query: "Show my project commitments",
          excludeToolIds: restriction === "excluded" ? ["app.work_items.show"] : undefined,
        },
        {
          ...dependencies,
          listNative: () => getGovernedTools().flatMap(item => {
            if (item.id !== "app.work_items.show" || restriction === "excluded") return [item];
            if (restriction === "unavailable") return [];
            return [{ ...item, ...(restriction === "inactive" ? { status: "planned" as const } : { riskLevel: 3 as const }) }];
          }),
        },
      );

      expect(result.definitions.map(item => item.id)).toContain("app.projects.show");
      expect(result.definitions.map(item => item.id)).not.toContain("app.work_items.show");
    },
  );

  it("reserves the exact canary grants from real governed schemas under candidate pressure", async () => {
    const descriptors = Array.from(
      { length: AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT },
      (_, index) => descriptor(`mcp:workspace:search-${index}`),
    );
    const userPrompt = [
      "Please ask Scout to inspect our delegation setup using Search Knowledge and List Runs,",
      "then ask Mnemosyne to check our stored AI-agent patterns using Search Memory and Search Knowledge.",
      "Give each agent only those read-only tools, make sure each one actually uses both, and have Sentinel review each result.",
      "Keep the tasks separate, don't browse the web or use my Mac, and don't make changes.",
    ].join(" ");
    const prefix = dynamicDelegationCapabilityQueryPrefix(userPrompt);
    const longPrompt = composeCapabilitySearchQuery(
      prefix,
      `${userPrompt} ${"coordination noise ".repeat(80)}`,
    );

    expect(prefix).toBe(
      "app.agents.delegate knowledge.search runs.list memory.search",
    );
    expect(longPrompt.startsWith(prefix)).toBe(true);
    expect(longPrompt.length).toBeGreaterThan(CAPABILITY_MAX_QUERY_LENGTH);

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: longPrompt },
      {
        listNative: getGovernedTools,
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: longPrompt,
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp: vi.fn(async (id) => tool({ id, category: "mcp" })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.length).toBeLessThanOrEqual(AGENT_MODEL_TOOL_LIMIT);
    expect(result.definitions.map((item) => item.id)).toEqual(expect.arrayContaining([
      "app.agents.delegate",
      "knowledge.search",
      "runs.list",
      "memory.search",
    ]));
    expect(result.definitions.map((item) => item.id)).not.toContain("web.search");
    const governed = new Map(getGovernedTools().map((item) => [item.id, item]));
    for (const id of [
      "app.agents.delegate",
      "knowledge.search",
      "runs.list",
      "memory.search",
    ]) {
      expect(result.definitions.find((item) => item.id === id)?.inputSchema)
        .toEqual(governed.get(id)?.inputSchema);
    }
  });

  it("does not expose delegation for descriptive or negative agent language", async () => {
    for (const query of [
      "Explain child agents; do not create one.",
      "Research delegation patterns without spawning an agent.",
    ]) {
      const result = await loadProgressiveAgentTools(
        { tenantId: "tenant-a", query },
        {
          listNative: getGovernedTools,
          search: vi.fn(async () => ({
            capabilities: [],
            query,
            total: 0,
            limit: 50,
            hasMore: false,
          })),
          resolveMcp: vi.fn(async () => null),
          resolveOpenApi: vi.fn(async () => null),
        },
      );

      expect(result.definitions.map((item) => item.id))
        .not.toContain("app.agents.delegate");
    }
  });

  it("hydrates only the top six metadata matches by default", async () => {
    const descriptors = Array.from(
      { length: 20 },
      (_, index) => descriptor(`mcp:mail:tool-${index}`),
    );
    const search = vi.fn(async () => ({
      capabilities: descriptors,
      query: "mail",
      total: descriptors.length,
      limit: 24,
      hasMore: false,
    }));
    const resolveMcp = vi.fn(async (id: string) => tool({ id, category: "mcp" }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "mail" },
      {
        listNative: () => [tool({ id: "memory.search" })],
        search,
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(resolveMcp).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT);
    expect(result.definitions).toHaveLength(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      query: "mail",
      sources: ["mcp", "openapi"],
    }));
  });

  it("reserves room for risk-zero resolvers from the action connector", async () => {
    const descriptors = [
      descriptor("mcp:github:actions_run_trigger", "mcp", 2),
      descriptor("mcp:github:create_issue", "mcp", 2),
      descriptor("mcp:github:update_file", "mcp", 2),
      descriptor("mcp:github:dispatch_deployment", "mcp", 2),
      descriptor("mcp:github:publish_release", "mcp", 2),
      descriptor("mcp:github:send_notification", "mcp", 2),
      descriptor("mcp:github:actions_list", "mcp", 0),
      descriptor("mcp:github:actions_get", "mcp", 0),
    ];
    const resolveMcp = vi.fn(async (id: string) => tool({
      id,
      category: "mcp",
      riskLevel: id.endsWith("_list") || id.endsWith("_get") ? 0 : 2,
      approvalRequired: id === "mcp:github:actions_run_trigger",
      approvalFingerprint: id === "mcp:github:actions_run_trigger"
        ? "reviewed-action-contract"
        : undefined,
    }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "run the github blog workflow" },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: "run the github blog workflow",
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:github:actions_run_trigger",
      "mcp:github:create_issue",
      "mcp:github:update_file",
      "mcp:github:dispatch_deployment",
      "mcp:github:actions_list",
      "mcp:github:actions_get",
    ]);
    expect(result.definitions[0]).toMatchObject({
      approvalRequired: true,
      approvalFingerprint: "reviewed-action-contract",
    });
    expect(resolveMcp).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT);
  });

  it("discovers missing resolvers with tenant-scoped same-connector metadata", async () => {
    const search = vi.fn(async (input: { query?: string }) => ({
      capabilities: input.query === "run portfolio blog automation"
        ? [descriptor("mcp:github:actions_run_trigger", "mcp", 2)]
        : [
            descriptor("mcp:github:actions_list", "mcp", 0),
            descriptor("mcp:github:actions_get", "mcp", 0),
            descriptor("mcp:slack:search_messages", "mcp", 0),
          ],
      query: input.query || "",
      total: 3,
      limit: 50,
      hasMore: false,
    }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "run portfolio blog automation" },
      {
        listNative: () => [],
        search,
        resolveMcp: vi.fn(async (id) => tool({
          id,
          category: "mcp",
          riskLevel: id.includes("run_trigger") ? 2 : 0,
        })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:github:actions_run_trigger",
      "mcp:github:actions_list",
      "mcp:github:actions_get",
    ]);
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tenantId: "tenant-private",
      query: expect.stringMatching(/github.*search.*list.*get.*find.*lookup.*read/),
      sources: ["mcp"],
    }));
  });

  it("hydrates no more than twelve exact allowlisted tools and skips other sources", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `openapi:mail:send-${index}`);
    const search = vi.fn(async (input: { query?: string }) => ({
      capabilities: input.query
        ? []
        : ids.map((id) => descriptor(id, "openapi")),
      query: input.query || "",
      total: input.query ? 0 : ids.length,
      limit: 48,
      hasMore: false,
    }));
    const resolveOpenApi = vi.fn(async (id: string) => tool({ id, category: "openapi" }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "ignored", preferredToolIds: ids },
      {
        listNative: () => [tool({ id: "memory.search" })],
        search,
        resolveMcp: vi.fn(async () => null),
        resolveOpenApi,
      },
    );

    expect(resolveOpenApi).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT);
    expect(result.definitions).toHaveLength(AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: undefined,
      allowlist: ids,
    }));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("does not hydrate high-risk metadata and fails closed on resolver errors", async () => {
    const resolveMcp = vi.fn(async (id: string) => {
      if (id.endsWith("broken")) throw new Error("offline");
      return tool({ id, category: "mcp" });
    });
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "connector" },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: [
            descriptor("mcp:connector:blocked", "mcp", 3),
            descriptor("mcp:connector:broken"),
            descriptor("mcp:connector:ready"),
          ],
          query: "connector",
          total: 3,
          limit: 24,
          hasMore: false,
        })),
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(resolveMcp).toHaveBeenCalledTimes(2);
    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:connector:ready",
    ]);
  });

  it("keeps one connector source available when the other catalog fails", async () => {
    const search = vi.fn(async (input: { sources?: readonly string[] }) => {
      if (input.sources?.length === 2 || input.sources?.[0] === "openapi") {
        throw new Error("OpenAPI catalog unavailable");
      }
      return {
        capabilities: [descriptor("mcp:connector:ready")],
        query: "connector",
        total: 1,
        limit: 24,
        hasMore: false,
      };
    });
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "connector" },
      {
        listNative: () => [],
        search,
        resolveMcp: vi.fn(async (id) => tool({ id, category: "mcp" })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:connector:ready",
    ]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("enforces serialized per-tool and per-run schema byte budgets", () => {
    const result = applyToolSchemaBudget(
      [
        tool({ id: "small-a", inputSchema: { value: "1234" } }),
        tool({ id: "too-large", inputSchema: { value: "x".repeat(80) } }),
        tool({ id: "small-b", inputSchema: { value: "5678" } }),
      ],
      { perToolBytes: 40, perRunBytes: 20 },
    );

    expect(result.definitions.map((item) => item.id)).toEqual(["small-a"]);
    expect(result.omittedToolIds).toEqual(["too-large", "small-b"]);
    expect(result.schemaBytes).toBe(
      Buffer.byteLength(JSON.stringify({ value: "1234" }), "utf8"),
    );
  });

  it("reserves both real reader schemas before admitting a compact inventory", () => {
    const first = governedTool("app.projects.list");
    const inventory = governedTool("app.projects.show");
    const reader = governedTool("app.work_items.show");
    const pairBytes = schemaBytes(inventory) + schemaBytes(reader);
    const budget = schemaBytes(first) + pairBytes;
    const fits = applyToolSchemaBudget([first, inventory, reader], { perRunBytes: budget });
    expect(fits.definitions.map(item => item.id)).toEqual([first.id, inventory.id, reader.id]);
    expect(fits.schemaBytes).toBe(budget);

    const constrained = applyToolSchemaBudget([first, inventory, reader], { perRunBytes: budget - 1 });
    expect(constrained.definitions.map(item => item.id)).toEqual([first.id, reader.id]);
    expect(constrained.omittedToolIds).toEqual([inventory.id]);
    expect(constrained.schemaBytes).toBe(schemaBytes(first) + schemaBytes(reader));
  });

  it("omits compact inventory when its selected reader exceeds the schema cap", async () => {
    const result = await loadProgressiveAgentTools(
      { query: "Show my project commitments" },
      {
        ...governedDependencies(),
        listNative: () => getGovernedTools().map(item => item.id === "app.work_items.show"
          ? { ...item, inputSchema: { ...item.inputSchema, description: "x".repeat(AGENT_TOOL_SCHEMA_MAX_BYTES) } }
          : item),
      },
    );

    expect(result.definitions.map(item => item.id)).not.toContain("app.projects.show");
    expect(result.definitions.map(item => item.id)).not.toContain("app.work_items.show");
    expect(result.omittedToolIds).toEqual(expect.arrayContaining([
      "app.projects.show", "app.work_items.show",
    ]));
    expect(result.schemaBytes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_RUN_MAX_BYTES);
  });

  it("creates deterministic collision-resistant model function names", () => {
    expect(capabilityFunctionName("knowledge.search")).toBe(
      "knowledge_search_f2405c6159c995e8",
    );
    const first = capabilityFunctionName("mcp:mail/send:message");
    const same = capabilityFunctionName("mcp:mail/send:message");
    const formerlyColliding = capabilityFunctionName("mcp:mail_send:message");

    expect(first).toBe(same);
    expect(first).not.toBe(formerlyColliding);
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(60);
  });
});

function governedDependencies(descriptors: CapabilityDescriptor[] = []) {
  return {
    listNative: getGovernedTools,
    search: vi.fn(async () => ({ capabilities: descriptors, query: "", total: descriptors.length, limit: 50, hasMore: false })),
    resolveMcp: vi.fn(async (id: string) => tool({ id, category: "mcp" })),
    resolveOpenApi: vi.fn(async () => null),
  };
}

function governedTool(id: string): ToolDefinition {
  const definition = getGovernedTools().find(item => item.id === id);
  if (!definition) throw new Error(`Missing governed tool ${id}`);
  return definition;
}

function schemaBytes(definition: ToolDefinition) {
  return Buffer.byteLength(JSON.stringify(definition.inputSchema), "utf8");
}

function descriptor(
  id: string,
  source: "mcp" | "openapi" = "mcp",
  riskLevel: 0 | 1 | 2 | 3 = 1,
): CapabilityDescriptor {
  return {
    id,
    name: id,
    description: "External operation.",
    category: source,
    source,
    riskLevel,
    approvalRequired: riskLevel >= 2,
    reversible: false,
  };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "memory.search",
    name: "Tool",
    description: "Tool description.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    inputSchema: { type: "object" },
    ...overrides,
  };
}
