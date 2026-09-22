import { describe, expect, it } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
  buildCustomAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { buildDelegationContextCapsuleV1 } from "@/lib/delegation/context-capsule";
import {
  buildDelegationExecutionContractV2,
  buildDelegationRuntimeAssignmentReceiptV1,
  parseDelegationExecutionContractV2,
  parseDelegationRuntimeAssignmentReceiptV1,
} from "@/lib/delegation/execution-contract";
import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";

type BuildExecutionContractInput = Parameters<
  typeof buildDelegationExecutionContractV2
>[0];

describe("delegation execution contract v2", () => {
  it.each(["isolated", "fork", "team"] as const)(
    "binds a provider-neutral %s execution to identities, capabilities, resources, context, and verification",
    (mode) => {
      const contract = build({ mode });

      expect(contract).toMatchObject({
        version: "delegation-execution-contract:2",
        mode,
        lineage: {
          depth: 1,
          maxDepth: 1,
          parentDelegationId: null,
        },
        runtimeAssignment: {
          providerId: "openai",
          modelId: "gpt-6-astra",
          normalizedReasoningEffort: "ultra",
          credentialMaterialIncluded: false,
        },
        authorityBoundary: {
          credentialMaterialIncluded: false,
          messageContentGrantsAuthority: false,
          retrievedDataGrantsAuthority: false,
          capabilityMetadataGrantsAuthority: false,
          authoritySource: "attenuated_parent_v1_grants_only",
        },
      });
      expect(contract.delegatorIdentity.definitionSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.delegateIdentity.principalSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.grants.skills[0]).toMatchObject({
        skillId: "skill-one",
        skillVersion: 3,
      });
      expect(contract.grants.mcpServers[0]).toMatchObject({
        serverId: "mcp:github",
        governedToolIds: ["runs.list"],
      });
      expect(contract.grants.plugins[0]).toMatchObject({
        pluginId: "plugin:delivery",
      });
      expect(contract.resourceClaims.map((claim) => claim.mode)).toEqual([
        "exclusive",
        "shared_read",
      ]);
      expect(contract.contractId).toBe(
        `delegation-execution-contract:${contract.contractSha256}`,
      );
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.grants.skills)).toBe(true);
    },
  );

  it("rejects authority, budgets, capabilities, and writable claims absent from the parent", () => {
    expect(() => build({
      grants: {
        ...grants,
        capabilityGrantIds: ["grant:capability:other"],
      },
    })).toThrow(/cannot exceed parent V1 authority/);
    expect(() => build({
      budgets: { ...childBudgets, toolCalls: 11 },
    })).toThrow(/cannot exceed its parent limit/);
    expect(() => build({
      grants: {
        ...grants,
        mcpServers: [{
          ...grants.mcpServers[0],
          governedToolIds: ["tools.ungranted"],
        }],
      },
    })).toThrow(/MCP grant exceeds/);
    expect(() => build({
      resourceClaims: [{
        claimId: "claim:unauthorized",
        resourceType: "repository_path",
        resourceId: "src/unowned.ts",
        mode: "exclusive",
        authorityGrantId: "grant:capability:other",
        baseRevisionSha256: null,
      }],
    })).toThrow(/resource claim exceeds/);
  });

  it("rejects undeclared or tampered Skill pins", () => {
    expect(() => build({
      grants: {
        ...grants,
        skills: [{
          ...grants.skills[0],
          skillSha256: "f".repeat(64),
        }],
      },
    })).toThrow(/Skill grant is not pinned/);
  });

  it("rejects nested lineage, cross-run context, and mutated runtime or contract receipts", () => {
    expect(() => build({
      lineage: {
        ...lineage,
        rootExecutionId: "run-other",
      },
    })).toThrow(/lineage|context/i);

    const runtime = runtimeAssignment();
    expect(() => parseDelegationRuntimeAssignmentReceiptV1({
      ...runtime,
      modelId: "other-model",
    })).toThrow(/integrity/i);

    const contract = build();
    expect(() => parseDelegationExecutionContractV2({
      ...contract,
      objective: "Widened after construction.",
    })).toThrow(/integrity/i);
  });

  it("rejects credentials, open output schemas, retry expansion, and parent deadline expansion", () => {
    expect(() => build({
      objective: "Use password:verysecretvalue to inspect the project.",
    })).toThrow(/credential material/i);
    expect(() => build({
      output: {
        ...output,
        schema: { type: "object", additionalProperties: true },
      },
    })).toThrow(/not closed and bounded/);
    expect(() => build({
      retry: {
        ...retry,
        maxAttempts: 3,
        backoffMs: [100, 200],
      },
    })).toThrow(/retry and Agent budgets/i);
    expect(() => build({
      deadline: {
        ...deadline,
        completeBy: "2026-09-22T12:31:00.000Z",
      },
    })).toThrow(/parent deadline/i);
  });
});

const tenantId = "tenant-one";
const actorId = "actor-one";
const delegationId = "delegation:one";
const parentRunId = "run-root";
const delegateRunId = "run-worker";
const verifierRunId = "run-verifier";

const delegatorPin = buildAgentRunIdentityPinV1({
  runId: parentRunId,
  identity: buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId,
    controllerActorId: actorId,
  }),
});
const delegatePin = buildAgentRunIdentityPinV1({
  runId: delegateRunId,
  identity: buildCustomAgentIdentityV1({
    agent: customAgent(),
    skills: [skill()],
    definitionVersion: 1,
    principalGeneration: 1,
  }),
});
const verifierPin = buildAgentRunIdentityPinV1({
  runId: verifierRunId,
  identity: buildBuiltInAgentIdentityV1({
    agentId: "sentinel",
    tenantId,
    controllerActorId: actorId,
  }),
});

const lineage: BuildExecutionContractInput["lineage"] = {
  tenantId,
  initiatingActorId: actorId,
  rootExecutionId: parentRunId,
  rootPrincipalId: delegatorPin.principalId,
  parentExecutionId: parentRunId,
  parentPrincipalId: delegatorPin.principalId,
  parentDelegationId: null,
  depth: 1,
  maxDepth: 1,
  workspaceId: "workspace:one",
  projectId: "project:one",
  workItemId: "work-item:one",
  correlationSha256: "a".repeat(64),
};

const grants: BuildExecutionContractInput["grants"] = {
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  governedToolIds: ["runs.list"],
  connectorTargets: ["connector:github"],
  skills: [{
    capabilityGrantId: "grant:capability:one",
    skillId: delegatePin.skillPins[0].skillId,
    skillVersion: delegatePin.skillPins[0].skillVersion,
    skillVersionId: delegatePin.skillPins[0].skillVersionId,
    skillSha256: delegatePin.skillPins[0].skillSha256,
  }],
  mcpServers: [{
    capabilityGrantId: "grant:capability:one",
    serverId: "mcp:github",
    serverVersionId: "mcp:github:v1",
    serverContractSha256: "b".repeat(64),
    governedToolIds: ["runs.list"],
    connectorTargetIds: ["connector:github"],
  }],
  plugins: [{
    capabilityGrantId: "grant:capability:one",
    installationId: "plugin-installation:one",
    pluginId: "plugin:delivery",
    pluginVersion: "1.2.0",
    manifestSha256: "c".repeat(64),
    componentIds: ["component:research"],
  }],
};

const parentGrants: DelegationContractV1["grants"] = {
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  governedToolIds: ["runs.list"],
  connectorTargets: ["connector:github"],
};

const parentBudgets: RunBudgetCountersV1 = {
  modelTurns: 4,
  tokens: 20_000,
  costMicrousd: 500_000,
  wallTimeMs: 180_000,
  toolCalls: 10,
  browserActions: 0,
  agents: 3,
  fanOut: 2,
  retries: 2,
  replans: 0,
};

const childBudgets: RunBudgetCountersV1 = {
  modelTurns: 1,
  tokens: 4_000,
  costMicrousd: 100_000,
  wallTimeMs: 60_000,
  toolCalls: 1,
  browserActions: 0,
  agents: 1,
  fanOut: 0,
  retries: 1,
  replans: 0,
};

const output: BuildExecutionContractInput["output"] = {
  outputContractId: "output-contract:one",
  schemaId: "worker-result",
  schemaVersion: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["completed", "blocked"] },
    },
  },
  artifactKinds: ["result" as const, "verification" as const],
  maxArtifacts: 4,
  maxBytes: 32_000,
};

const retry: BuildExecutionContractInput["retry"] = {
  maxAttempts: 2,
  backoffMs: [250],
  retryableReasons: ["transient_provider" as const],
  neverRetryReasons: [
    "authority_denied" as const,
    "contract_invalid" as const,
    "canceled" as const,
    "deadline_expired" as const,
  ],
};

const deadline: BuildExecutionContractInput["deadline"] = {
  createdAt: "2026-09-22T12:00:00.000Z",
  acceptBy: "2026-09-22T12:01:00.000Z",
  completeBy: "2026-09-22T12:05:00.000Z",
};

function runtimeAssignment() {
  return buildDelegationRuntimeAssignmentReceiptV1({
    executionId: delegateRunId,
    providerId: "openai",
    modelId: "gpt-6-astra",
    modelTier: "reasoning",
    reasoningProfileId: "adaptive-ultra",
    normalizedReasoningEffort: "ultra",
    routingPolicyId: "model-route:delegation:v1",
    routingPolicySha256: "d".repeat(64),
    assignedAt: deadline.createdAt,
  });
}

function build(
  overrides: Partial<Parameters<typeof buildDelegationExecutionContractV2>[0]> = {},
) {
  const mode = overrides.mode || "isolated";
  const effectiveLineage = overrides.lineage || lineage;
  const contextCapsule = buildDelegationContextCapsuleV1({
    mode,
    scope: {
      tenantId: effectiveLineage.tenantId,
      initiatingActorId: effectiveLineage.initiatingActorId,
      rootExecutionId: effectiveLineage.rootExecutionId,
      rootPrincipalId: effectiveLineage.rootPrincipalId,
      parentExecutionId: effectiveLineage.parentExecutionId,
      parentPrincipalId: effectiveLineage.parentPrincipalId,
      delegationId,
    },
    contextRefs: [{
      contextRefId: "context:one",
      sourceKind: "workspace_state",
      sourceId: "workspace:one",
      revisionId: "workspace:one:v4",
      contentSha256: "e".repeat(64),
      contextGrantId: "grant:context:one",
      trust: "trusted_first_party",
      selectedByteCount: 100,
    }],
    ...(mode === "fork" ? {
      parentTranscript: {
        manifestId: "transcript-manifest:one",
        turns: [{
          sequence: 0,
          turnId: "turn:one",
          role: "user" as const,
          contentSha256: "f".repeat(64),
          selectedByteCount: 100,
        }],
      },
    } : {}),
  });
  return buildDelegationExecutionContractV2({
    delegationId,
    mode,
    lineage: effectiveLineage,
    delegatorIdentityPin: delegatorPin,
    delegateIdentityPin: delegatePin,
    runtimeAssignment: runtimeAssignment(),
    contextCapsule,
    purpose: "delegation.work.execute",
    objective: "Complete the bounded work and return independently verifiable evidence.",
    idempotencyKeySha256: "1".repeat(64),
    acceptance: {
      acceptanceId: "acceptance:one",
      criteria: [{
        criterionId: "criterion:one",
        criterionSha256: "2".repeat(64),
        verificationMethod: "parent_verifier",
        required: true,
      }],
    },
    output,
    verifier: {
      verifierContractId: "verifier-contract:one",
      verifierPolicyId: "verifier-policy:one",
      verifierPolicySha256: "3".repeat(64),
      identityPin: verifierPin,
      method: "agent_then_deterministic",
      requiredEvidenceKinds: ["artifact_digest", "acceptance_check"],
      acceptanceThreshold: 0.9,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
    grants,
    resourceClaims: [{
      claimId: "claim:source",
      resourceType: "repository_path",
      resourceId: "src/lib/example.ts",
      mode: "exclusive",
      authorityGrantId: "grant:capability:one",
      baseRevisionSha256: null,
    }, {
      claimId: "claim:docs",
      resourceType: "repository_path",
      resourceId: "docs/architecture.md",
      mode: "shared_read",
      authorityGrantId: "grant:context:one",
      baseRevisionSha256: "4".repeat(64),
    }],
    parentAuthority: {
      grants: parentGrants,
      budgets: parentBudgets,
      completeBy: "2026-09-22T12:30:00.000Z",
    },
    budgets: childBudgets,
    deadline,
    cancellation: {
      cancelable: true,
      signalId: "delegation-signal:one",
      allowedInitiators: ["parent", "owner", "system"],
      acknowledgementDeadlineMs: 5_000,
    },
    retry,
    ...overrides,
  });
}

function customAgent(): CustomAgentDefinition {
  return {
    id: "worker-one",
    tenantId,
    actorId,
    slug: "worker-one",
    name: "Worker One",
    role: "Bounded execution worker",
    description: "Completes one bounded assignment and returns exact evidence.",
    instructions: "Follow the delegation contract and do not widen authority.",
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    modelPolicy: "auto",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    memoryScope: "project",
    skillIds: ["skill-one"],
    toolIds: ["runs.list"],
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

function skill(): AgentSkill {
  return {
    id: "skill-one",
    tenantId,
    actorId,
    slug: "bounded-research",
    name: "Bounded research",
    description: "Collect exact evidence for a bounded assignment.",
    instructions: "Use only granted sources and cite exact evidence.",
    category: "research",
    status: "active",
    version: 3,
    toolIds: ["runs.list"],
    tags: [],
    knowledgeTags: [],
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}
