import { describe, expect, it, vi } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import { buildDelegationContextCapsuleV1 } from "@/lib/delegation/context-capsule";
import {
  MAX_PARENT_HARNESS_TOOL_IDS,
  resolveDelegationGrantsV1,
  revalidateDelegationGrantsV1,
} from "@/lib/delegation/grant-resolver";
import {
  buildExecutionContract,
  executionParentBudgets,
} from "@/lib/delegation/test-fixtures";
import {
  buildPluginInstallation,
  pluginManifestSha256,
  type PluginManifest,
} from "@/lib/plugins/contracts";
import type { PluginInstallationRecord } from "@/lib/plugins/store";
import { getBuiltInSkill } from "@/lib/skills/catalog";
import { pluginSkillIdForInstallation } from "@/lib/skills/store";
import type { AgentSkill } from "@/lib/skills/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";

describe("delegation grant resolver", () => {
  it.each([
    ["scout", "core.research", "knowledge.search"],
    ["forge", "engineering.implementation", "app.projects.builder.file.read"],
  ] as const)(
    "activates an exact Atlas Skill for compatible %s delegates",
    async (delegateAgentId, skillId, toolId) => {
      const authority = builtInAuthority(delegateAgentId, [toolId], [skillId]);
      const skill = requireBuiltInSkill(skillId);
      const resolution = await resolveDelegationGrantsV1({
        ...authority.input,
        request: { skillIds: [skillId] },
      }, {
        getSkill: vi.fn(async () => skill),
      });

      expect(resolution.skills).toEqual([
        expect.objectContaining({ id: skillId, instructions: skill.instructions }),
      ]);
      expect(resolution.governedToolIds).toContain(toolId);
      expect(resolution.grants.skills[0]).toMatchObject({
        skillId,
        skillVersion: 1,
      });
      expect(resolution.grants.capabilityGrantIds).toEqual(
        expect.arrayContaining([
          resolution.grants.skills[0].capabilityGrantId,
        ]),
      );
    },
  );

  it("rejects a Skill that the selected specialist identity does not pin", async () => {
    const skillId = "engineering.implementation";
    const authority = builtInAuthority("scout", [], [skillId]);

    await expect(resolveDelegationGrantsV1({
      ...authority.input,
      request: { skillIds: [skillId] },
    }, {
      getSkill: vi.fn(async () => requireBuiltInSkill(skillId)),
    })).rejects.toThrow(/incompatible with the selected delegate/i);
  });

  it("accepts a large persisted parent toolbox while retaining the child cap", async () => {
    const parentToolIds = Array.from({ length: 100 }, (_, index) =>
      `parent.read.tool.${String(index).padStart(3, "0")}`
    );
    expect(parentToolIds.length).toBeLessThanOrEqual(MAX_PARENT_HARNESS_TOOL_IDS);
    const authority = builtInAuthority("scout", parentToolIds, []);

    const resolution = await resolveDelegationGrantsV1({
      ...authority.input,
      request: {},
    });

    expect(resolution.grants.governedToolIds).toEqual([]);
    expect(resolution.parentAuthorityGrants.governedToolIds).toHaveLength(100);
  });

  it.each([
    "google.gmail.search",
    "moltbook.feed.read",
  ])(
    "rejects the exact-owner connector %s at creation and worker revalidation",
    async (toolId) => {
      const authority = builtInAuthority("scout", [toolId], []);

      await expect(resolveDelegationGrantsV1({
        ...authority.input,
        request: { governedReadToolIds: [toolId] },
      })).rejects.toThrow(/credential-owner binding/i);

      const emptyResolution = await resolveDelegationGrantsV1({
        ...authority.input,
        request: {},
      });
      const unsafeResolution = {
        ...emptyResolution,
        governedToolIds: [toolId],
        grants: {
          ...emptyResolution.grants,
          governedToolIds: [toolId],
        },
      };
      const unsafeContract = contractForResolution(
        authority,
        unsafeResolution,
      );

      await expect(revalidateDelegationGrantsV1({
        contract: unsafeContract,
        parentIdentityPin: authority.parentPin,
        delegateIdentityPin: authority.delegatePin,
        parentEvents: authority.events,
      })).rejects.toThrow(/credential-owner binding/i);
    },
  );

  it("does not treat a provider callable name as canonical grant authority", async () => {
    const authority = builtInAuthority(
      "scout",
      ["knowledge.search"],
      [],
    );

    await expect(resolveDelegationGrantsV1({
      ...authority.input,
      request: {
        governedReadToolIds: ["knowledge_search_f2405c6159c995e8"],
      },
    })).rejects.toThrow(/exceeds the persisted parent harness/i);
  });

  it("rejects parent attenuation gaps and changed or disabled Skill pins", async () => {
    const skillId = "core.research";
    const skill = requireBuiltInSkill(skillId);
    const missingToolAuthority = builtInAuthority("scout", [], [skillId]);
    await expect(resolveDelegationGrantsV1({
      ...missingToolAuthority.input,
      request: { governedReadToolIds: ["knowledge.search"] },
    })).rejects.toThrow(/exceeds the persisted parent harness/i);

    const authority = builtInAuthority("scout", ["knowledge.search"], [skillId]);
    await expect(resolveDelegationGrantsV1({
      ...authority.input,
      request: { skillIds: [skillId] },
    }, {
      getSkill: vi.fn(async () => ({ ...skill, version: 2 })),
    })).rejects.toThrow(/version changed/i);

    const resolution = await resolveDelegationGrantsV1({
      ...authority.input,
      request: { skillIds: [skillId] },
    }, {
      getSkill: vi.fn(async () => skill),
    });
    const contract = contractForResolution(authority, resolution);
    await expect(revalidateDelegationGrantsV1({
      contract,
      parentIdentityPin: authority.parentPin,
      delegateIdentityPin: authority.delegatePin,
      parentEvents: authority.events,
    }, {
      getSkill: vi.fn(async () => ({ ...skill, status: "disabled" as const })),
    })).rejects.toThrow(/disabled or unavailable/i);
  });

  it("activates an exact actor Plugin Skill from Atlas for a built-in delegate and fails after disable", async () => {
    const fixture = pluginAuthority();
    const dependencies = {
      getSkill: vi.fn(async () => fixture.skill),
      listPlugins: vi.fn(async () => [fixture.record]),
      getNativeTool: vi.fn((toolId: string) => getGovernedTool(toolId)),
    };
    const resolution = await resolveDelegationGrantsV1({
      ...fixture.authority.input,
      request: {
        plugins: [{
          installationId: fixture.record.installation.installationId,
          componentIds: ["skill:review"],
        }],
      },
    }, dependencies);
    const contract = contractForResolution(fixture.authority, resolution);

    expect(contract.grants.plugins[0]).toMatchObject({
      installationId: fixture.record.installation.installationId,
      installationRevision: 1,
      installationSha256: fixture.record.installation.installationSha256,
      componentIds: ["skill:review"],
    });
    expect(contract.grants.skills[0].skillId).toBe(fixture.skill.id);
    expect(JSON.stringify(contract.grants)).not.toContain(fixture.manifest.description);

    const disabled: PluginInstallationRecord = {
      manifest: fixture.manifest,
      installation: buildPluginInstallation({
        installationId: fixture.record.installation.installationId,
        manifest: fixture.manifest,
        state: "disabled",
        revision: 2,
        installedAt: fixture.record.installation.installedAt,
        updatedAt: "2026-09-22T01:00:00.000Z",
      }),
    };
    await expect(revalidateDelegationGrantsV1({
      contract,
      parentIdentityPin: fixture.authority.parentPin,
      delegateIdentityPin: fixture.authority.delegatePin,
      parentEvents: fixture.authority.events,
    }, {
      ...dependencies,
      listPlugins: vi.fn(async () => [disabled]),
    })).rejects.toThrow(/disabled, uninstalled, or unavailable/i);
  });

  it("pins reviewed read-only MCP contracts and fails closed on revoke or drift", async () => {
    const connector = mcpConnector();
    const tool = mcpTool(connector);
    const authority = builtInAuthority("scout", [tool.id], []);
    const dependencies = {
      getMcpConnector: vi.fn(async () => connector),
      getMcpTool: vi.fn(async () => tool),
    };
    const resolution = await resolveDelegationGrantsV1({
      ...authority.input,
      request: {
        mcpServers: [{
          serverId: connector.id,
          governedToolIds: [tool.id],
        }],
      },
    }, dependencies);
    const contract = contractForResolution(authority, resolution);

    expect(contract.grants.mcpServers[0]).toMatchObject({
      serverId: connector.id,
      governedToolIds: [tool.id],
    });
    expect(JSON.stringify(contract.grants)).not.toContain(connector.endpoint);
    expect(JSON.stringify(contract.grants)).not.toContain(connector.authTokenEnv);

    await expect(revalidateDelegationGrantsV1({
      contract,
      parentIdentityPin: authority.parentPin,
      delegateIdentityPin: authority.delegatePin,
      parentEvents: authority.events,
    }, {
      ...dependencies,
      getMcpTool: vi.fn(async () => ({ ...tool, status: "pending_review" as const })),
    })).rejects.toThrow(/reviewed active read contract/i);

    await expect(revalidateDelegationGrantsV1({
      contract,
      parentIdentityPin: authority.parentPin,
      delegateIdentityPin: authority.delegatePin,
      parentEvents: authority.events,
    }, {
      ...dependencies,
      getMcpTool: vi.fn(async () => ({
        ...tool,
        inputSchema: { type: "object", properties: { changed: { type: "string" } } },
      })),
    })).rejects.toThrow(/MCP contract changed/i);
  });
});

type AuthorityFixture = ReturnType<typeof builtInAuthority>;

function builtInAuthority(
  delegateAgentId: "scout" | "forge",
  toolIds: readonly string[],
  skillIds: readonly string[],
) {
  const tenantId = "tenant-one";
  const actorId = "actor-one";
  const parentExecutionId = "run-root";
  const parentPin = buildAgentRunIdentityPinV1({
    runId: parentExecutionId,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const delegatePin = buildAgentRunIdentityPinV1({
    runId: "run-child",
    identity: buildBuiltInAgentIdentityV1({
      agentId: delegateAgentId,
      tenantId,
      controllerActorId: actorId,
    }),
  });
  return authorityFixture({
    tenantId,
    actorId,
    parentExecutionId,
    parentPin,
    delegatePin,
    toolIds,
    skillIds,
  });
}

function authorityFixture(input: {
  tenantId: string;
  actorId: string;
  parentExecutionId: string;
  parentPin: AgentRunIdentityPinV1;
  delegatePin: AgentRunIdentityPinV1;
  toolIds: readonly string[];
  skillIds: readonly string[];
}) {
  const toolIds = [...input.toolIds].sort();
  const skillIds = [...input.skillIds].sort();
  const parentExecutionScope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: input.parentPin.principalId,
    correlationId: input.parentExecutionId,
    contextGrantIds: ["context:parent"],
    capabilityGrantIds: ["capability:parent"],
    purpose: "agent.run",
  });
  const events = [{
    type: "run.harness",
    payload: {
      type: "harness",
      toolCount: toolIds.length,
      toolIds,
      skillIds,
      toolboxSha256: "1".repeat(64),
      instructionsSha256: "2".repeat(64),
    },
  }];
  return {
    parentPin: input.parentPin,
    delegatePin: input.delegatePin,
    events,
    input: {
      tenantId: input.tenantId,
      actorId: input.actorId,
      parentExecutionId: input.parentExecutionId,
      parentIdentityPin: input.parentPin,
      delegateIdentityPin: input.delegatePin,
      parentExecutionScope,
      parentEvents: events,
    },
  };
}

function contractForResolution(
  authority: AuthorityFixture,
  resolution: Awaited<ReturnType<typeof resolveDelegationGrantsV1>>,
) {
  const base = buildExecutionContract();
  const lineage = {
    ...base.lineage,
    rootPrincipalId: authority.parentPin.principalId,
    parentPrincipalId: authority.parentPin.principalId,
  };
  const contextCapsule = buildDelegationContextCapsuleV1({
    mode: base.mode,
    scope: {
      tenantId: lineage.tenantId,
      initiatingActorId: lineage.initiatingActorId,
      rootExecutionId: lineage.rootExecutionId,
      rootPrincipalId: lineage.rootPrincipalId,
      parentExecutionId: lineage.parentExecutionId,
      parentPrincipalId: lineage.parentPrincipalId,
      delegationId: base.delegationId,
    },
  });
  return buildExecutionContract({
    lineage,
    delegatorIdentityPin: authority.parentPin,
    delegateIdentityPin: authority.delegatePin,
    contextCapsule,
    grants: resolution.grants,
    parentAuthority: {
      grants: resolution.parentAuthorityGrants,
      budgets: executionParentBudgets,
      completeBy: "2026-09-22T12:30:00.000Z",
    },
  });
}

function pluginAuthority() {
  const tenantId = "tenant-one";
  const actorId = "actor-one";
  const parentExecutionId = "run-root";
  const manifest = pluginManifest();
  const installation = buildPluginInstallation({
    installationId: "plugin-installation:review-one",
    manifest,
    revision: 1,
    installedAt: "2026-09-22T00:00:00.000Z",
  });
  const template = manifest.skills[0];
  const skill: AgentSkill = {
    id: pluginSkillIdForInstallation(installation.installationId, template.key),
    tenantId,
    actorId,
    slug: "plugin-review",
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    category: template.category,
    status: "active",
    version: 1,
    toolIds: [...template.toolIds],
    tags: [...template.tags],
    knowledgeTags: [...template.knowledgeTags],
    sourcePluginInstallationId: installation.installationId,
    sourcePluginId: manifest.pluginId,
    sourcePluginVersion: manifest.version,
    sourcePluginSkillKey: template.key,
    sourcePluginManifestSha256: pluginManifestSha256(manifest),
    sourcePluginSkillSha256: canonicalJsonSha256({
      schemaVersion: 1,
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      manifestSha256: canonicalJsonSha256(manifest),
      template,
    }),
    createdAt: installation.installedAt,
    updatedAt: installation.updatedAt,
  };
  const parentPin = buildAgentRunIdentityPinV1({
    runId: parentExecutionId,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const delegatePin = buildAgentRunIdentityPinV1({
    runId: "run-child",
    identity: buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const authority = authorityFixture({
    tenantId,
    actorId,
    parentExecutionId,
    parentPin,
    delegatePin,
    toolIds: ["knowledge.search"],
    skillIds: parentPin.skillPins.map((pin) => pin.skillId),
  });
  return {
    authority,
    manifest,
    skill,
    record: { installation, manifest } satisfies PluginInstallationRecord,
  };
}

function pluginManifest(): PluginManifest {
  return {
    schemaVersion: 1,
    pluginId: "test.review",
    version: "1.0.0",
    name: "Review Plugin",
    description: "Provides one bounded read-only review Skill for tests.",
    publisher: { id: "test.publisher", name: "Test Publisher" },
    license: "MIT",
    skills: [{
      key: "review",
      name: "Plugin Review",
      description: "Reviews one bounded artifact using governed evidence.",
      instructions: "Read only the granted evidence and return a bounded review.",
      category: "analysis",
      toolIds: ["knowledge.search"],
      tags: ["review"],
      knowledgeTags: [],
    }],
    mcpTemplates: [],
    workflowTemplates: [],
  };
}

function mcpConnector(): McpConnectorRecord {
  return {
    id: "mcp-server-one",
    tenantId: "tenant-one",
    name: "Read server",
    endpoint: "https://mcp.example.test/api",
    transport: "streamable_http",
    authType: "bearer_env",
    authTokenEnv: "PRIVATE_MCP_TOKEN",
    credentialConfigured: true,
    credentialVersion: 3,
    credentialOriginMatch: true,
    status: "active",
    defaultRiskLevel: 0,
    approvalRequired: false,
    toolCount: 1,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

function mcpTool(connector: McpConnectorRecord): McpToolRecord {
  return {
    id: `mcp:${connector.id}:lookup`,
    tenantId: connector.tenantId,
    connectorId: connector.id,
    connectorName: connector.name,
    name: "lookup",
    title: "Lookup",
    description: "Read one exact public record.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false },
    riskLevel: 0,
    approvalRequired: false,
    status: "active",
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

function requireBuiltInSkill(skillId: string) {
  const skill = getBuiltInSkill(skillId);
  if (!skill) throw new Error(`Missing built-in Skill ${skillId}.`);
  return skill;
}
