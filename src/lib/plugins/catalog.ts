import {
  parsePluginManifest,
  pluginManifestSha256,
  type PluginManifest,
} from "@/lib/plugins/contracts";

export type PluginCatalogEntry = Readonly<{
  schemaVersion: 1;
  catalogId: string;
  source: "asael_curated";
  pluginId: string;
  version: string;
  name: string;
  description: string;
  publisher: PluginManifest["publisher"];
  manifestSha256: string;
  componentCounts: Readonly<{
    skills: number;
    mcpTemplates: number;
    workflowTemplates: number;
  }>;
  trust: Readonly<{
    declarativeOnly: true;
    containsExecutableCode: false;
    containsCredentials: false;
    externalConnectionsRequireReview: true;
    workflowTemplatesMetadataOnly: true;
  }>;
  manifest: PluginManifest;
}>;

const githubProjectKit = parsePluginManifest({
  schemaVersion: 1,
  pluginId: "asael.github-project-kit",
  version: "1.0.0",
  name: "GitHub project kit",
  description:
    "Declarative templates for evidence-led repository triage and project delivery through a separately reviewed GitHub MCP connection.",
  publisher: {
    id: "asael",
    name: "Asael",
    homepageUrl: "https://asael.bennierichard.com",
  },
  license: "Proprietary",
  homepageUrl: "https://asael.bennierichard.com",
  skills: [
    {
      key: "repository-triage",
      name: "Repository triage",
      description: "Review repository evidence, isolate risks, and propose bounded next actions.",
      instructions:
        "Inspect repository evidence before proposing changes. Separate observed facts from inference, keep target scope explicit, and route every effect through governed tools and required approvals.",
      category: "analysis",
      toolIds: [
        "app.projects.builder.tree",
        "app.projects.builder.search",
        "app.projects.builder.file.read",
        "app.projects.builder.verification.show",
      ],
      tags: ["github", "repository", "review"],
      knowledgeTags: ["software-delivery"],
    },
  ],
  mcpTemplates: [
    {
      key: "github-official",
      name: "GitHub MCP",
      description:
        "Connection template for GitHub's official MCP endpoint. Installation stores no token and creates no connector.",
      endpoint: "https://api.githubcopilot.com/mcp/",
      transport: "streamable_http",
      authentication: "bearer",
      credentialSetup: "connect_after_install",
      capabilitySummary: [
        "Read repository and issue metadata after connector discovery and review.",
        "Propose repository mutations only through the governed tool executor and approval policy.",
      ],
    },
  ],
  workflowTemplates: [
    {
      key: "repository-health-review",
      name: "Repository health review",
      description:
        "A non-executable outline for collecting evidence, reviewing risks, and proposing a bounded delivery plan.",
      mode: "research",
      objectiveTemplate:
        "Review the selected repository, identify verified gaps and risks, and prepare an evidence-backed implementation plan.",
      steps: [
        "Confirm repository and actor scope.",
        "Collect reviewed repository evidence.",
        "Separate verified findings from hypotheses.",
        "Prepare a bounded plan with explicit approvals.",
      ],
      requiredSkillKeys: ["repository-triage"],
      requiredMcpTemplateKeys: ["github-official"],
      metadataOnly: true,
    },
  ],
});

export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = Object.freeze([
  catalogEntry(githubProjectKit),
]);

export function findPluginCatalogEntry(input: {
  pluginId: string;
  version: string;
  manifestSha256: string;
}) {
  return PLUGIN_CATALOG.find((entry) =>
    entry.pluginId === input.pluginId &&
    entry.version === input.version &&
    entry.manifestSha256 === input.manifestSha256
  );
}

function catalogEntry(manifest: PluginManifest): PluginCatalogEntry {
  return deepFreeze({
    schemaVersion: 1 as const,
    catalogId: `${manifest.pluginId}@${manifest.version}`,
    source: "asael_curated" as const,
    pluginId: manifest.pluginId,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    manifestSha256: pluginManifestSha256(manifest),
    componentCounts: {
      skills: manifest.skills.length,
      mcpTemplates: manifest.mcpTemplates.length,
      workflowTemplates: manifest.workflowTemplates.length,
    },
    trust: {
      declarativeOnly: true as const,
      containsExecutableCode: false as const,
      containsCredentials: false as const,
      externalConnectionsRequireReview: true as const,
      workflowTemplatesMetadataOnly: true as const,
    },
    manifest,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
