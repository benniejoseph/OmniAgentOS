export type AutomationResourceKey =
  | "skills"
  | "connections"
  | "mcp"
  | "tools"
  | "workflows"
  | "triggers"
  | "plugins";

export type JsonRecord = Record<string, unknown>;

export type AutomationSnapshot = Partial<
  Record<AutomationResourceKey, JsonRecord>
>;

export type CapabilityState = "available" | "partial" | "unavailable";

export type CapabilitySummary = {
  key: "access" | "actions" | "guidance" | "repeat" | "bundles";
  label: string;
  value: string;
  detail: string;
  state: CapabilityState;
};

export const MAX_PLUGIN_MANIFEST_BYTES = 128_000;

export const automationResourceDefinitions: ReadonlyArray<{
  key: AutomationResourceKey;
  label: string;
  endpoint: string;
}> = [
  { key: "skills", label: "Skills", endpoint: "/api/skills" },
  {
    key: "connections",
    label: "Account connections",
    endpoint: "/api/integrations/overview",
  },
  { key: "mcp", label: "MCP servers", endpoint: "/api/connectors" },
  { key: "tools", label: "Governed tools", endpoint: "/api/tools" },
  {
    key: "workflows",
    label: "Workflow runs",
    endpoint: "/api/workflows?limit=24",
  },
  {
    key: "triggers",
    label: "Automation triggers",
    endpoint: "/api/triggers?limit=48",
  },
  { key: "plugins", label: "Plugins", endpoint: "/api/plugins" },
] as const;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pluginManifestByteLength(source: string) {
  return new TextEncoder().encode(source).byteLength;
}

export function parseImportedPluginManifest(source: string): JsonRecord {
  if (!source.trim()) {
    throw new Error("Paste a Plugin manifest before preparing its review.");
  }
  const byteLength = pluginManifestByteLength(source);
  if (byteLength > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(
      `Plugin manifest is ${byteLength.toLocaleString()} bytes; the maximum is ${MAX_PLUGIN_MANIFEST_BYTES.toLocaleString()} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : "Invalid JSON syntax.";
    throw new Error(`Plugin manifest JSON could not be parsed: ${detail}`);
  }
  if (!isJsonRecord(parsed)) {
    throw new Error("A Plugin manifest must be one JSON object, not an array or primitive value.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error("A Plugin manifest must declare schemaVersion 1.");
  }
  return parsed;
}

export function importedPluginPreviewPayload(source: string): {
  manifest: JsonRecord;
} {
  return { manifest: parseImportedPluginManifest(source) };
}

export function recordsAt(value: unknown, key: string): JsonRecord[] {
  if (!isJsonRecord(value)) return [];
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate.filter(isJsonRecord) : [];
}

export function recordAt(value: unknown, key: string): JsonRecord | undefined {
  if (!isJsonRecord(value)) return undefined;
  const candidate = value[key];
  return isJsonRecord(candidate) ? candidate : undefined;
}

export function textAt(
  value: unknown,
  keys: readonly string[],
  fallback: string,
): string {
  if (!isJsonRecord(value)) return fallback;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return fallback;
}

export function numberAt(
  value: unknown,
  key: string,
  fallback = 0,
): number {
  if (!isJsonRecord(value)) return fallback;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : fallback;
}

export function stringListAt(value: unknown, key: string): string[] {
  if (!isJsonRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim()),
  );
}

function stateFor(
  snapshot: AutomationSnapshot,
  keys: readonly AutomationResourceKey[],
): CapabilityState {
  const available = keys.filter((key) => snapshot[key]).length;
  if (available === keys.length) return "available";
  return available ? "partial" : "unavailable";
}

function displayCount(
  snapshot: AutomationSnapshot,
  key: AutomationResourceKey,
  count: number,
): string {
  return snapshot[key] ? String(count) : "—";
}

export function buildCapabilitySummary(
  snapshot: AutomationSnapshot,
): CapabilitySummary[] {
  const connections = recordsAt(snapshot.connections, "installed").filter(
    (item) => textAt(item, ["kind"], "") !== "mcp",
  );
  const connectedAccounts = connections.filter(
    (item) => item.connected === true,
  ).length;
  const mcpServers = recordsAt(snapshot.mcp, "connectors");
  const activeMcp = mcpServers.filter(
    (item) => textAt(item, ["status"], "") === "active",
  ).length;
  const tools = recordsAt(snapshot.tools, "tools");
  const activeTools = tools.filter(
    (item) => textAt(item, ["status"], "") === "active",
  ).length;
  const skills = recordsAt(snapshot.skills, "skills");
  const activeSkills = skills.filter(
    (item) => textAt(item, ["status"], "") === "active",
  ).length;
  const triggers = recordsAt(snapshot.triggers, "triggers");
  const activeTriggers = triggers.filter(
    (item) => textAt(item, ["status"], "") === "active",
  ).length;
  const workflowRuns = recordsAt(snapshot.workflows, "runs");
  const runningWorkflows = workflowRuns.filter((item) =>
    ["queued", "running", "waiting_approval", "paused"].includes(
      textAt(item, ["canonicalStatus", "status"], ""),
    ),
  ).length;
  const installations = recordsAt(snapshot.plugins, "installations");
  const enabledPlugins = installations.filter(
    (item) => textAt(item, ["state", "status"], "unknown") === "enabled",
  ).length;

  return [
    {
      key: "access",
      label: "Access",
      value:
        snapshot.connections || snapshot.mcp
          ? String(connectedAccounts + activeMcp)
          : "—",
      detail: `${displayCount(snapshot, "connections", connectedAccounts)} connected · ${displayCount(snapshot, "mcp", activeMcp)} MCP`,
      state: stateFor(snapshot, ["connections", "mcp"]),
    },
    {
      key: "actions",
      label: "Actions",
      value: displayCount(snapshot, "tools", activeTools),
      detail: snapshot.tools
        ? `${tools.length} governed tools in inventory`
        : "Tool inventory unavailable",
      state: stateFor(snapshot, ["tools"]),
    },
    {
      key: "guidance",
      label: "Guidance",
      value: displayCount(snapshot, "skills", activeSkills),
      detail: snapshot.skills
        ? `${skills.length} reusable skills`
        : "Skill catalog unavailable",
      state: stateFor(snapshot, ["skills"]),
    },
    {
      key: "repeat",
      label: "Repeat",
      value: displayCount(snapshot, "triggers", activeTriggers),
      detail: `${displayCount(snapshot, "triggers", activeTriggers)} active triggers · ${displayCount(snapshot, "workflows", runningWorkflows)} live runs`,
      state: stateFor(snapshot, ["triggers", "workflows"]),
    },
    {
      key: "bundles",
      label: "Bundles",
      value: displayCount(snapshot, "plugins", enabledPlugins),
      detail: snapshot.plugins
        ? `${installations.length} plugin installations`
        : "Plugin catalog unavailable",
      state: stateFor(snapshot, ["plugins"]),
    },
  ];
}

export function summarizeRisk(toolsPayload: unknown) {
  const tools = recordsAt(toolsPayload, "tools");
  return ([0, 1, 2, 3] as const).map((level) => ({
    level,
    count: tools.filter((tool) => numberAt(tool, "riskLevel", -1) === level)
      .length,
  }));
}
