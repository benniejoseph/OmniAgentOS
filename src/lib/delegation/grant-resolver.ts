import { z } from "zod";

import {
  buildAgentSkillPinV1,
  parseAgentRunIdentityPinV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import { mcpToolContractFingerprint } from "@/lib/connectors/contract-review";
import {
  getMcpConnector,
  getMcpToolById,
} from "@/lib/connectors/store";
import type {
  McpConnectorRecord,
  McpToolRecord,
} from "@/lib/connectors/types";
import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import type { DelegationExecutionContractV2 } from "@/lib/delegation/execution-contract";
import {
  pluginManifestSha256,
  type PluginManifest,
} from "@/lib/plugins/contracts";
import {
  listPluginInstallations,
  type PluginInstallationRecord,
} from "@/lib/plugins/store";
import { getAgentSkill, pluginSkillIdForInstallation } from "@/lib/skills/store";
import type { AgentSkill } from "@/lib/skills/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolDefinition } from "@/lib/tools/types";

export const DELEGATION_GRANT_RESOLUTION_VERSION =
  "delegation-grant-resolution:1" as const;
export const MAX_DELEGATION_SKILL_GRANTS = 8;
export const MAX_DELEGATION_PLUGIN_GRANTS = 8;
export const MAX_DELEGATION_MCP_GRANTS = 8;
export const MAX_DELEGATION_READ_TOOLS = 16;
export const MAX_PARENT_HARNESS_TOOL_IDS = 256;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

const pluginRequestSchema = z.object({
  installationId: idSchema,
  componentIds: z.array(idSchema).min(1).max(16).refine(uniqueStrings),
}).strict();

const mcpRequestSchema = z.object({
  serverId: idSchema,
  governedToolIds: z.array(idSchema).min(1).max(8).refine(uniqueStrings),
}).strict();

export const delegationGrantRequestV1Schema = z.object({
  governedReadToolIds: z.array(idSchema)
    .max(MAX_DELEGATION_READ_TOOLS)
    .refine(uniqueStrings)
    .default([]),
  skillIds: z.array(idSchema)
    .max(MAX_DELEGATION_SKILL_GRANTS)
    .refine(uniqueStrings)
    .default([]),
  plugins: z.array(pluginRequestSchema)
    .max(MAX_DELEGATION_PLUGIN_GRANTS)
    .refine((items) => uniqueStrings(items.map((item) => item.installationId)))
    .default([]),
  mcpServers: z.array(mcpRequestSchema)
    .max(MAX_DELEGATION_MCP_GRANTS)
    .refine((items) => uniqueStrings(items.map((item) => item.serverId)))
    .default([]),
}).strict().superRefine((request, context) => {
  const toolIds = request.mcpServers.flatMap((server) => server.governedToolIds);
  if (!uniqueStrings(toolIds)) {
    context.addIssue({
      code: "custom",
      path: ["mcpServers"],
      message: "A governed MCP tool may appear under only one server grant.",
    });
  }
});

export type DelegationGrantRequestV1 = Readonly<
  z.infer<typeof delegationGrantRequestV1Schema>
>;

export type DelegationRuntimeSkillV1 = Readonly<{
  id: string;
  name: string;
  description: string;
  instructions: string;
  toolIds: readonly string[];
}>;

export type DelegationGrantRuntimeV1 = Readonly<{
  skills: readonly DelegationRuntimeSkillV1[];
  governedToolIds: readonly string[];
}>;

export type DelegationGrantResolutionV1 = DelegationGrantRuntimeV1 & Readonly<{
  version: typeof DELEGATION_GRANT_RESOLUTION_VERSION;
  requestSha256: string;
  parentHarnessSha256: string;
  grants: DelegationExecutionContractV2["grants"];
  parentAuthorityGrants: DelegationContractV1["grants"];
}>;

type ParentHarnessAuthorityV1 = Readonly<{
  parentExecutionId: string;
  toolIds: readonly string[];
  skillIds: readonly string[];
  toolboxSha256: string;
  instructionsSha256: string;
  harnessSha256: string;
}>;

type ParentEvent = Readonly<{
  type: string;
  payload: unknown;
}>;

type GrantResolverDependencies = Readonly<{
  getSkill: typeof getAgentSkill;
  listPlugins: typeof listPluginInstallations;
  getMcpConnector: typeof getMcpConnector;
  getMcpTool: typeof getMcpToolById;
  getNativeTool: typeof getGovernedTool;
}>;

const defaultDependencies: GrantResolverDependencies = Object.freeze({
  getSkill: getAgentSkill,
  listPlugins: listPluginInstallations,
  getMcpConnector,
  getMcpTool: getMcpToolById,
  getNativeTool: getGovernedTool,
});

export function parseDelegationGrantRequestV1(
  value: unknown,
): DelegationGrantRequestV1 {
  const parsed = delegationGrantRequestV1Schema.parse(value || {});
  return deepFreeze({
    governedReadToolIds: sorted(parsed.governedReadToolIds),
    skillIds: sorted(parsed.skillIds),
    plugins: [...parsed.plugins]
      .map((plugin) => ({
        installationId: plugin.installationId,
        componentIds: sorted(plugin.componentIds),
      }))
      .sort((left, right) => left.installationId.localeCompare(right.installationId)),
    mcpServers: [...parsed.mcpServers]
      .map((server) => ({
        serverId: server.serverId,
        governedToolIds: sorted(server.governedToolIds),
      }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId)),
  });
}

export function delegationGrantRequestSha256(value: unknown) {
  return canonicalJsonSha256(parseDelegationGrantRequestV1(value));
}

/**
 * Resolves an explicit request against the parent's persisted, actor-bound
 * harness and immutable identity. Returned grants contain IDs and digests
 * only; instructions are returned separately for the immediate child run.
 */
export async function resolveDelegationGrantsV1(input: {
  tenantId: string;
  actorId: string;
  parentExecutionId: string;
  parentIdentityPin: AgentRunIdentityPinV1;
  delegateIdentityPin: AgentRunIdentityPinV1;
  parentExecutionScope: ExecutionScope;
  parentEvents: readonly ParentEvent[];
  request: unknown;
}, dependencies: Partial<GrantResolverDependencies> = {}): Promise<
  DelegationGrantResolutionV1
> {
  const deps = { ...defaultDependencies, ...dependencies };
  const request = parseDelegationGrantRequestV1(input.request);
  const { parentPin: pin, delegatePin } = assertDelegationIdentities(input);
  const harness = extractParentHarnessAuthorityV1(
    input.parentExecutionId,
    input.parentEvents,
  );
  const skillPins = new Map(pin.skillPins.map((skill) => [skill.skillId, skill]));
  const delegateSkillPins = new Map(
    delegatePin.skillPins.map((skill) => [skill.skillId, skill]),
  );
  const skillById = new Map<string, AgentSkill>();
  const pluginGrants: DelegationExecutionContractV2["grants"]["plugins"] = [];

  const pluginRecords = request.plugins.length
    ? await deps.listPlugins({ tenantId: input.tenantId, actorId: input.actorId })
    : [];
  const pluginById = new Map(
    pluginRecords.map((record) => [record.installation.installationId, record]),
  );
  for (const requested of request.plugins) {
    const record = pluginById.get(requested.installationId);
    const resolved = requireEnabledPlugin(record, requested.componentIds);
    for (const componentId of requested.componentIds) {
      const skillKey = pluginSkillComponentKey(componentId);
      const template = resolved.manifest.skills.find((skill) => skill.key === skillKey);
      if (!template) {
        throw new Error("A requested Plugin Skill component is unavailable.");
      }
      const skillId = pluginSkillIdForInstallation(
        resolved.installation.installationId,
        skillKey,
      );
      const skill = await requireActiveActorSkill({
        skillId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        dependencies: deps,
      });
      assertPluginSkillProjection(skill, resolved, skillKey, template);
      if (skillById.has(skillId)) {
        throw new Error("A delegated Skill was selected more than once.");
      }
      skillById.set(skillId, skill);
    }
    const pluginBinding = pluginGrantBinding(resolved, requested.componentIds);
    pluginGrants.push({
      capabilityGrantId: capabilityGrantId(pin, harness, "plugin", pluginBinding),
      installationId: resolved.installation.installationId,
      installationRevision: resolved.installation.revision,
      installationSha256: resolved.installation.installationSha256,
      pluginId: resolved.installation.pluginId,
      pluginVersion: resolved.installation.pluginVersion,
      manifestSha256: resolved.installation.manifestSha256,
      componentIds: sorted(requested.componentIds),
    });
  }

  for (const skillId of request.skillIds) {
    const skill = await requireActiveParentSkill({
      skillId,
      tenantId: input.tenantId,
      actorId: input.actorId,
      harness,
      skillPins,
      dependencies: deps,
    });
    if (skill.sourcePluginInstallationId) {
      throw new Error(
        "Plugin-projected Skills require their exact Plugin installation grant.",
      );
    }
    assertCompatibleDelegateSkill(skill, delegateSkillPins);
    if (skillById.has(skillId)) {
      throw new Error("A delegated Skill was selected more than once.");
    }
    skillById.set(skillId, skill);
  }

  const skillGrants = [...skillById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((skill) => {
      const skillPin = buildAgentSkillPinV1(skill);
      return {
        capabilityGrantId: capabilityGrantId(pin, harness, "skill", skillPin),
        ...skillPin,
      };
    });

  const nativeToolIds = new Set<string>();
  for (const toolId of request.governedReadToolIds) {
    requireParentTool(toolId, harness);
    const tool = deps.getNativeTool(toolId);
    if (tool?.category === "connector") {
      throw new Error(
        "A native connector tool requires a verified credential-owner binding before delegation.",
      );
    }
    if (!tool || isExternalToolId(toolId) || !isDelegableReadTool(tool)) {
      throw new Error("A requested governed tool is not an active native read tool.");
    }
    nativeToolIds.add(toolId);
  }
  for (const skill of skillById.values()) {
    for (const toolId of skill.toolIds) {
      if (isExternalToolId(toolId) || !harness.toolIds.includes(toolId)) continue;
      const tool = deps.getNativeTool(toolId);
      if (tool && isDelegableReadTool(tool)) nativeToolIds.add(toolId);
    }
  }

  const mcpGrants: DelegationExecutionContractV2["grants"]["mcpServers"] = [];
  const mcpToolIds = new Set<string>();
  const connectorTargets = new Set<string>();
  for (const requested of request.mcpServers) {
    const resolved = await resolveMcpGrant({
      tenantId: input.tenantId,
      harness,
      requested,
      dependencies: deps,
    });
    const binding = mcpGrantBinding(resolved.connector, resolved.tools);
    mcpGrants.push({
      capabilityGrantId: capabilityGrantId(pin, harness, "mcp", binding),
      serverId: resolved.connector.id,
      serverVersionId: `mcp-server:${resolved.connector.id}:${binding.serverContractSha256.slice(0, 32)}`,
      serverContractSha256: binding.serverContractSha256,
      governedToolIds: resolved.tools.map((tool) => tool.id),
      connectorTargetIds: [resolved.connector.id],
    });
    connectorTargets.add(resolved.connector.id);
    for (const tool of resolved.tools) mcpToolIds.add(tool.id);
  }

  const governedToolIds = sorted([...nativeToolIds, ...mcpToolIds]);
  if (governedToolIds.length > MAX_DELEGATION_READ_TOOLS) {
    throw new Error(
      `Delegation grants may expose at most ${MAX_DELEGATION_READ_TOOLS} read tools.`,
    );
  }
  const capabilityGrantIds = sorted([
    ...skillGrants.map((grant) => grant.capabilityGrantId),
    ...pluginGrants.map((grant) => grant.capabilityGrantId),
    ...mcpGrants.map((grant) => grant.capabilityGrantId),
  ]);
  const requestSha256 = canonicalJsonSha256(request);
  const grants = {
    grantRequestSha256: requestSha256,
    contextGrantIds: [],
    capabilityGrantIds,
    governedToolIds,
    connectorTargets: sorted(connectorTargets),
    skills: skillGrants,
    mcpServers: mcpGrants,
    plugins: pluginGrants,
  } satisfies DelegationExecutionContractV2["grants"];
  const runtime = runtimeFromSkills(skillById, governedToolIds);
  return deepFreeze({
    version: DELEGATION_GRANT_RESOLUTION_VERSION,
    requestSha256,
    parentHarnessSha256: harness.harnessSha256,
    grants,
    parentAuthorityGrants: {
      contextGrantIds: [...input.parentExecutionScope.contextGrantIds],
      capabilityGrantIds: sorted([
        ...input.parentExecutionScope.capabilityGrantIds,
        ...capabilityGrantIds,
      ]),
      governedToolIds: [...harness.toolIds],
      connectorTargets: sorted(connectorTargets),
    },
    ...runtime,
  });
}

/** Re-resolves every immutable grant immediately before a worker claim. */
export async function revalidateDelegationGrantsV1(input: {
  contract: DelegationExecutionContractV2;
  parentIdentityPin: AgentRunIdentityPinV1;
  delegateIdentityPin: AgentRunIdentityPinV1;
  parentEvents: readonly ParentEvent[];
}, dependencies: Partial<GrantResolverDependencies> = {}): Promise<
  DelegationGrantRuntimeV1
> {
  const deps = { ...defaultDependencies, ...dependencies };
  const contract = input.contract;
  const pin = parseAgentRunIdentityPinV1(input.parentIdentityPin);
  const delegatePin = parseAgentRunIdentityPinV1(input.delegateIdentityPin);
  const harness = extractParentHarnessAuthorityV1(
    contract.lineage.parentExecutionId,
    input.parentEvents,
  );
  if (
    pin.pinSha256 !== contract.delegatorIdentity.identityPinSha256 ||
    delegatePin.pinSha256 !== contract.delegateIdentity.identityPinSha256 ||
    pin.tenantId !== contract.lineage.tenantId ||
    pin.actorId !== contract.lineage.initiatingActorId ||
    delegatePin.tenantId !== contract.lineage.tenantId ||
    delegatePin.actorId !== contract.lineage.initiatingActorId
  ) {
    throw new Error("The parent identity no longer matches this grant contract.");
  }
  const skillPins = new Map(pin.skillPins.map((skill) => [skill.skillId, skill]));
  const delegateSkillPins = new Map(
    delegatePin.skillPins.map((skill) => [skill.skillId, skill]),
  );
  const pluginBackedSkillIds = new Set(contract.grants.plugins.flatMap((plugin) =>
    plugin.componentIds.map((componentId) => pluginSkillIdForInstallation(
      plugin.installationId,
      pluginSkillComponentKey(componentId),
    ))
  ));
  const skillById = new Map<string, AgentSkill>();
  for (const grant of contract.grants.skills) {
    const pluginBacked = pluginBackedSkillIds.has(grant.skillId);
    const skill = pluginBacked
      ? await requireActiveActorSkill({
          skillId: grant.skillId,
          tenantId: contract.lineage.tenantId,
          actorId: contract.lineage.initiatingActorId,
          dependencies: deps,
        })
      : await requireActiveParentSkill({
          skillId: grant.skillId,
          tenantId: contract.lineage.tenantId,
          actorId: contract.lineage.initiatingActorId,
          harness,
          skillPins,
          dependencies: deps,
        });
    const exactPin = buildAgentSkillPinV1(skill);
    if (
      grant.skillVersion !== exactPin.skillVersion ||
      grant.skillVersionId !== exactPin.skillVersionId ||
      grant.skillSha256 !== exactPin.skillSha256 ||
      grant.capabilityGrantId !== capabilityGrantId(pin, harness, "skill", exactPin)
    ) {
      throw new Error("A delegated Skill pin changed before worker claim.");
    }
    if (!pluginBacked) {
      assertCompatibleDelegateSkill(skill, delegateSkillPins);
    }
    skillById.set(skill.id, skill);
  }

  const pluginRecords = contract.grants.plugins.length
    ? await deps.listPlugins({
        tenantId: contract.lineage.tenantId,
        actorId: contract.lineage.initiatingActorId,
      })
    : [];
  const pluginById = new Map(
    pluginRecords.map((record) => [record.installation.installationId, record]),
  );
  const backedPluginSkillIds = new Set<string>();
  for (const grant of contract.grants.plugins) {
    const record = pluginById.get(grant.installationId);
    const resolved = requireEnabledPlugin(record, grant.componentIds);
    const binding = pluginGrantBinding(resolved, grant.componentIds);
    if (
      grant.installationRevision !== resolved.installation.revision ||
      grant.installationSha256 !== resolved.installation.installationSha256 ||
      grant.pluginId !== resolved.installation.pluginId ||
      grant.pluginVersion !== resolved.installation.pluginVersion ||
      grant.manifestSha256 !== resolved.installation.manifestSha256 ||
      grant.capabilityGrantId !== capabilityGrantId(pin, harness, "plugin", binding)
    ) {
      throw new Error("A delegated Plugin pin changed before worker claim.");
    }
    for (const componentId of grant.componentIds) {
      const skillKey = pluginSkillComponentKey(componentId);
      const template = resolved.manifest.skills.find((skill) => skill.key === skillKey);
      if (!template) throw new Error("A delegated Plugin component changed.");
      const skillId = pluginSkillIdForInstallation(grant.installationId, skillKey);
      const skill = skillById.get(skillId);
      if (!skill) throw new Error("A Plugin Skill grant is missing its Skill pin.");
      assertPluginSkillProjection(skill, resolved, skillKey, template);
      backedPluginSkillIds.add(skillId);
    }
  }
  for (const skill of skillById.values()) {
    if (skill.sourcePluginInstallationId && !backedPluginSkillIds.has(skill.id)) {
      throw new Error("A Plugin-projected Skill lost its installation binding.");
    }
  }

  const mcpToolIds = new Set<string>();
  const connectorTargets = new Set<string>();
  for (const grant of contract.grants.mcpServers) {
    const resolved = await resolveMcpGrant({
      tenantId: contract.lineage.tenantId,
      harness,
      requested: {
        serverId: grant.serverId,
        governedToolIds: grant.governedToolIds,
      },
      dependencies: deps,
    });
    const binding = mcpGrantBinding(resolved.connector, resolved.tools);
    if (
      grant.serverVersionId !==
        `mcp-server:${resolved.connector.id}:${binding.serverContractSha256.slice(0, 32)}` ||
      grant.serverContractSha256 !== binding.serverContractSha256 ||
      grant.capabilityGrantId !== capabilityGrantId(pin, harness, "mcp", binding) ||
      canonicalJsonSha256(grant.connectorTargetIds) !==
        canonicalJsonSha256([resolved.connector.id])
    ) {
      throw new Error("A delegated MCP contract changed before worker claim.");
    }
    connectorTargets.add(resolved.connector.id);
    for (const tool of resolved.tools) mcpToolIds.add(tool.id);
  }

  for (const toolId of contract.grants.governedToolIds) {
    requireParentTool(toolId, harness);
    if (isExternalToolId(toolId)) {
      if (!mcpToolIds.has(toolId) || !toolId.startsWith("mcp:")) {
        throw new Error("An external delegated tool lacks an exact MCP grant.");
      }
      continue;
    }
    const tool = deps.getNativeTool(toolId);
    if (tool?.category === "connector") {
      throw new Error(
        "A delegated native connector tool lacks a verified credential-owner binding.",
      );
    }
    if (!tool || !isDelegableReadTool(tool)) {
      throw new Error("A delegated native tool is no longer read-only.");
    }
  }
  if (
    canonicalJsonSha256(sorted(mcpToolIds)) !==
      canonicalJsonSha256(
        contract.grants.governedToolIds.filter((toolId) => toolId.startsWith("mcp:")),
      ) ||
    canonicalJsonSha256(sorted(connectorTargets)) !==
      canonicalJsonSha256(contract.grants.connectorTargets)
  ) {
    throw new Error("Delegated MCP authority does not reconcile.");
  }
  const exactCapabilities = sorted([
    ...contract.grants.skills.map((grant) => grant.capabilityGrantId),
    ...contract.grants.plugins.map((grant) => grant.capabilityGrantId),
    ...contract.grants.mcpServers.map((grant) => grant.capabilityGrantId),
  ]);
  if (
    canonicalJsonSha256(exactCapabilities) !==
      canonicalJsonSha256(contract.grants.capabilityGrantIds)
  ) {
    throw new Error("Delegated capability grant identities do not reconcile.");
  }
  return deepFreeze(runtimeFromSkills(
    skillById,
    contract.grants.governedToolIds,
  ));
}

function assertDelegationIdentities(input: {
  tenantId: string;
  actorId: string;
  parentExecutionId: string;
  parentIdentityPin: AgentRunIdentityPinV1;
  delegateIdentityPin: AgentRunIdentityPinV1;
  parentExecutionScope: ExecutionScope;
}) {
  const parentPin = parseAgentRunIdentityPinV1(input.parentIdentityPin);
  const delegatePin = parseAgentRunIdentityPinV1(input.delegateIdentityPin);
  const scope = input.parentExecutionScope;
  if (
    parentPin.runId !== input.parentExecutionId ||
    parentPin.tenantId !== input.tenantId ||
    parentPin.actorId !== input.actorId ||
    delegatePin.runId === parentPin.runId ||
    delegatePin.tenantId !== input.tenantId ||
    delegatePin.actorId !== input.actorId ||
    scope.tenantId !== input.tenantId ||
    scope.initiatingActorId !== input.actorId ||
    scope.correlationId !== input.parentExecutionId ||
    scope.executingPrincipalId !== parentPin.principalId ||
    scope.delegationId !== null
  ) {
    throw new Error("Delegation grants require the exact persisted root identity.");
  }
  return { parentPin, delegatePin };
}

function extractParentHarnessAuthorityV1(
  parentExecutionId: string,
  events: readonly ParentEvent[],
): ParentHarnessAuthorityV1 {
  const harnesses = events.filter((event) => event.type === "run.harness");
  if (harnesses.length !== 1) {
    throw new Error("Delegation grants require one persisted parent harness.");
  }
  const payload = harnesses[0].payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The persisted parent harness is invalid.");
  }
  const record = payload as Record<string, unknown>;
  const toolIds = exactIdArray(record.toolIds, MAX_PARENT_HARNESS_TOOL_IDS);
  const skillIds = exactIdArray(record.skillIds, 50);
  const toolboxSha256 = exactSha256(record.toolboxSha256);
  const instructionsSha256 = exactSha256(record.instructionsSha256);
  if (
    record.type !== "harness" ||
    record.toolCount !== toolIds.length
  ) {
    throw new Error("The persisted parent harness authority does not reconcile.");
  }
  const body = {
    schemaVersion: 1,
    parentExecutionId,
    toolIds,
    skillIds,
    toolboxSha256,
    instructionsSha256,
  };
  return deepFreeze({
    parentExecutionId,
    toolIds,
    skillIds,
    toolboxSha256,
    instructionsSha256,
    harnessSha256: canonicalJsonSha256(body),
  });
}

async function requireActiveParentSkill(input: {
  skillId: string;
  tenantId: string;
  actorId: string;
  harness: ParentHarnessAuthorityV1;
  skillPins: ReadonlyMap<string, AgentRunIdentityPinV1["skillPins"][number]>;
  dependencies: GrantResolverDependencies;
}) {
  if (!input.harness.skillIds.includes(input.skillId)) {
    throw new Error("A delegated Skill was not active in the parent harness.");
  }
  const expectedPin = input.skillPins.get(input.skillId);
  if (!expectedPin) {
    throw new Error("A delegated Skill was not pinned by the parent identity.");
  }
  const skill = await requireActiveActorSkill({
    skillId: input.skillId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    dependencies: input.dependencies,
  });
  const currentPin = buildAgentSkillPinV1(skill);
  if (
    expectedPin.skillVersion !== currentPin.skillVersion ||
    expectedPin.skillVersionId !== currentPin.skillVersionId ||
    expectedPin.skillSha256 !== currentPin.skillSha256
  ) {
    throw new Error("A delegated Skill version changed after the parent run.");
  }
  return skill;
}

async function requireActiveActorSkill(input: {
  skillId: string;
  tenantId: string;
  actorId: string;
  dependencies: GrantResolverDependencies;
}) {
  const skill = await input.dependencies.getSkill(input.skillId, {
    tenantId: input.tenantId,
    actorId: input.actorId,
  });
  if (!skill || skill.status !== "active") {
    throw new Error("A delegated Skill is disabled or unavailable.");
  }
  if (
    !skill.builtIn &&
    (skill.tenantId !== input.tenantId || skill.actorId !== input.actorId)
  ) {
    throw new Error("A delegated Skill belongs to another actor scope.");
  }
  return skill;
}

function assertCompatibleDelegateSkill(
  skill: AgentSkill,
  delegateSkillPins: ReadonlyMap<
    string,
    AgentRunIdentityPinV1["skillPins"][number]
  >,
) {
  const expected = delegateSkillPins.get(skill.id);
  const current = buildAgentSkillPinV1(skill);
  if (
    !expected ||
    expected.skillVersion !== current.skillVersion ||
    expected.skillVersionId !== current.skillVersionId ||
    expected.skillSha256 !== current.skillSha256
  ) {
    throw new Error(
      "A delegated Skill is incompatible with the selected delegate identity.",
    );
  }
}

function requireEnabledPlugin(
  record: PluginInstallationRecord | undefined,
  componentIds: readonly string[],
) {
  if (!record || record.installation.state !== "enabled") {
    throw new Error("A delegated Plugin is disabled, uninstalled, or unavailable.");
  }
  if (
    record.installation.manifestSha256 !== pluginManifestSha256(record.manifest)
  ) {
    throw new Error("A delegated Plugin manifest digest changed.");
  }
  for (const componentId of componentIds) {
    const key = pluginSkillComponentKey(componentId);
    const projected = record.installation.components.skills.find(
      (component) => component.key === key,
    );
    if (!projected || projected.state !== "active") {
      throw new Error("A delegated Plugin component is inactive.");
    }
  }
  return record;
}

function pluginSkillComponentKey(componentId: string) {
  if (!componentId.startsWith("skill:") || componentId.length <= 6) {
    throw new Error(
      "Only explicit Plugin Skill components can become delegation runtime authority.",
    );
  }
  return componentId.slice(6);
}

function assertPluginSkillProjection(
  skill: AgentSkill,
  record: PluginInstallationRecord,
  skillKey: string,
  template: PluginManifest["skills"][number],
) {
  const expectedSkillSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    pluginId: record.manifest.pluginId,
    pluginVersion: record.manifest.version,
    manifestSha256: canonicalJsonSha256(record.manifest),
    template,
  });
  if (
    skill.sourcePluginInstallationId !== record.installation.installationId ||
    skill.sourcePluginId !== record.installation.pluginId ||
    skill.sourcePluginVersion !== record.installation.pluginVersion ||
    skill.sourcePluginSkillKey !== skillKey ||
    skill.sourcePluginManifestSha256 !== record.installation.manifestSha256 ||
    skill.sourcePluginSkillSha256 !== expectedSkillSha256
  ) {
    throw new Error("A Plugin Skill projection changed after installation.");
  }
}

function pluginGrantBinding(
  record: PluginInstallationRecord,
  componentIds: readonly string[],
) {
  return {
    installationId: record.installation.installationId,
    installationRevision: record.installation.revision,
    installationSha256: record.installation.installationSha256,
    pluginId: record.installation.pluginId,
    pluginVersion: record.installation.pluginVersion,
    manifestSha256: record.installation.manifestSha256,
    componentIds: sorted(componentIds),
  };
}

async function resolveMcpGrant(input: {
  tenantId: string;
  harness: ParentHarnessAuthorityV1;
  requested: Readonly<{ serverId: string; governedToolIds: readonly string[] }>;
  dependencies: GrantResolverDependencies;
}) {
  const connector = await input.dependencies.getMcpConnector(
    input.requested.serverId,
    { tenantId: input.tenantId },
  );
  if (!connector || connector.status !== "active") {
    throw new Error("A delegated MCP server is disabled or unavailable.");
  }
  const tools: McpToolRecord[] = [];
  for (const toolId of sorted(input.requested.governedToolIds)) {
    requireParentTool(toolId, input.harness);
    const tool = await input.dependencies.getMcpTool(toolId, {
      tenantId: input.tenantId,
    });
    if (
      !tool ||
      tool.connectorId !== connector.id ||
      tool.status !== "active" ||
      tool.riskLevel !== 0 ||
      tool.approvalRequired
    ) {
      throw new Error("A delegated MCP tool is not a reviewed active read contract.");
    }
    tools.push(tool);
  }
  return { connector, tools };
}

function mcpGrantBinding(
  connector: McpConnectorRecord,
  tools: readonly McpToolRecord[],
) {
  const contract = {
    schemaVersion: 1,
    serverId: connector.id,
    serverState: connector.status,
    endpointContractSha256: canonicalJsonSha256({
      endpoint: connector.endpoint,
      transport: connector.transport,
      authType: connector.authType,
      authTokenEnv: connector.authTokenEnv || null,
      credentialVersion: connector.credentialVersion || null,
      credentialOriginMatch: connector.credentialOriginMatch ?? null,
    }),
    tools: [...tools]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((tool) => ({
        toolId: tool.id,
        contractSha256: mcpToolContractFingerprint(tool, connector),
        status: tool.status,
        riskLevel: tool.riskLevel,
        approvalRequired: tool.approvalRequired,
      })),
  };
  return {
    serverContractSha256: canonicalJsonSha256(contract),
  };
}

function capabilityGrantId(
  parentPin: AgentRunIdentityPinV1,
  harness: ParentHarnessAuthorityV1,
  kind: "skill" | "plugin" | "mcp",
  binding: unknown,
) {
  const digest = canonicalJsonSha256({
    schemaVersion: 1,
    kind,
    parentIdentityPinSha256: parentPin.pinSha256,
    parentHarnessSha256: harness.harnessSha256,
    binding,
  });
  return `delegation-capability:${digest.slice(0, 48)}`;
}

function requireParentTool(
  toolId: string,
  harness: ParentHarnessAuthorityV1,
) {
  if (!harness.toolIds.includes(toolId)) {
    throw new Error("A delegated tool exceeds the persisted parent harness.");
  }
}

function isDelegableReadTool(tool: ToolDefinition) {
  return tool.status === "active" &&
    tool.category !== "connector" &&
    tool.riskLevel === 0 &&
    !tool.approvalRequired &&
    tool.operationClass !== "mutation";
}

function isExternalToolId(toolId: string) {
  return toolId.startsWith("mcp:") || toolId.startsWith("openapi:");
}

function runtimeFromSkills(
  skillById: ReadonlyMap<string, AgentSkill>,
  governedToolIds: readonly string[],
): DelegationGrantRuntimeV1 {
  const grantedTools = new Set(governedToolIds);
  return {
    skills: [...skillById.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        toolIds: sorted(skill.toolIds.filter((toolId) => grantedTools.has(toolId))),
      })),
    governedToolIds: [...governedToolIds],
  };
}

function exactIdArray(value: unknown, max: number) {
  const parsed = z.array(idSchema).max(max).refine(uniqueStrings).parse(value);
  if (canonicalJsonSha256(parsed) !== canonicalJsonSha256(sorted(parsed))) {
    throw new Error("Persisted parent harness IDs are not canonical.");
  }
  return parsed;
}

function exactSha256(value: unknown) {
  return z.string().regex(/^[a-f0-9]{64}$/).parse(value);
}

function uniqueStrings(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function sorted(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
