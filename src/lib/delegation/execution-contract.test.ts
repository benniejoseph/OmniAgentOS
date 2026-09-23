import { describe, expect, it } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { buildDelegationContextCapsuleV1 } from "@/lib/delegation/context-capsule";
import {
  DELEGATION_PERSONA_BRIEF_MAX_GUIDANCE_LENGTH,
  buildDelegationExecutionContractV2,
  buildDelegationRuntimeAssignmentReceiptV1,
  parseDelegationExecutionContractV2,
  parseDelegationRuntimeAssignmentReceiptV1,
} from "@/lib/delegation/execution-contract";
import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

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
        skillId: "core.research",
        skillVersion: 1,
      });
      expect(contract.grants.mcpServers[0]).toMatchObject({
        serverId: "mcp:github",
        governedToolIds: ["runs.list"],
      });
      expect(contract.grants.plugins).toEqual([]);
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

  it("binds an optional non-authoritative persona brief without changing the v2 contract version", () => {
    const contract = build({
      personaBrief: {
        label: "Forensic reviewer",
        guidance: "Be skeptical, concise, and explicit about evidence gaps.",
        promptSha256: "7".repeat(64),
      },
    });

    expect(contract).toMatchObject({
      schemaVersion: 2,
      version: "delegation-execution-contract:2",
      personaBrief: {
        schemaVersion: 1,
        label: "Forensic reviewer",
        authorityEffect: "none",
        briefSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        promptSha256: "7".repeat(64),
      },
    });
    expect(parseDelegationExecutionContractV2(contract)).toEqual(contract);
  });

  it("keeps old v2 contracts valid and rejects an oversized persona brief", () => {
    const oldContract = build();
    expect(oldContract.personaBrief).toBeUndefined();
    expect(parseDelegationExecutionContractV2(oldContract)).toEqual(oldContract);

    expect(() => build({
      personaBrief: {
        label: "Bounded reviewer",
        guidance: "x".repeat(DELEGATION_PERSONA_BRIEF_MAX_GUIDANCE_LENGTH + 1),
        promptSha256: "7".repeat(64),
      },
    })).toThrow();
  });

  it("binds exact required governed tools without widening the resolved grants", () => {
    const statement =
      "Invoke every exact harness-required governed tool and bind its governed execution receipt.";
    const requiredGovernedToolIds = ["runs.list"];
    const acceptance = {
      acceptanceId: "acceptance:required-tools",
      criteria: [{
        criterionId: "criterion:required-governed-tools:one",
        statement,
        criterionSha256: canonicalJsonSha256({
          statement,
          requiredGovernedToolIds,
        }),
        verificationMethod: "governed_receipt" as const,
        required: true as const,
        requiredGovernedToolIds,
      }],
    };
    const contract = build({ acceptance });

    expect(contract.acceptance.criteria[0]).toMatchObject({
      verificationMethod: "governed_receipt",
      requiredGovernedToolIds,
    });
    expect(parseDelegationExecutionContractV2(contract)).toEqual(contract);
    expect(() => build({
      acceptance: {
        ...acceptance,
        criteria: [{
          ...acceptance.criteria[0],
          requiredGovernedToolIds: ["knowledge.search"],
          criterionSha256: canonicalJsonSha256({
            statement,
            requiredGovernedToolIds: ["knowledge.search"],
          }),
        }],
      },
    })).toThrow(/required governed tools exceed the resolved grant boundary/i);
    expect(() => build({
      acceptance: {
        ...acceptance,
        criteria: [{
          ...acceptance.criteria[0],
          verificationMethod: "evidence",
        }],
      },
    })).toThrow(/governed-receipt verification/i);
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
  identity: buildBuiltInAgentIdentityV1({
    agentId: "scout",
    tenantId,
    controllerActorId: actorId,
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
const delegatorSkillPin = delegatorPin.skillPins.find(
  (pin) => pin.skillId === "core.research",
)!;

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
  grantRequestSha256: "9".repeat(64),
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  governedToolIds: ["runs.list"],
  connectorTargets: ["connector:github"],
  skills: [{
    capabilityGrantId: "grant:capability:one",
    skillId: delegatorSkillPin.skillId,
    skillVersion: delegatorSkillPin.skillVersion,
    skillVersionId: delegatorSkillPin.skillVersionId,
    skillSha256: delegatorSkillPin.skillSha256,
  }],
  mcpServers: [{
    capabilityGrantId: "grant:capability:one",
    serverId: "mcp:github",
    serverVersionId: "mcp:github:v1",
    serverContractSha256: "b".repeat(64),
    governedToolIds: ["runs.list"],
    connectorTargetIds: ["connector:github"],
  }],
  plugins: [],
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

function verifierRuntimeAssignment() {
  return buildDelegationRuntimeAssignmentReceiptV1({
    executionId: verifierRunId,
    providerId: "openai",
    modelId: "gpt-6-astra",
    modelTier: "reasoning",
    reasoningProfileId: "adaptive-ultra",
    normalizedReasoningEffort: "ultra",
    routingPolicyId: "model-route:verifier:v1",
    routingPolicySha256: "6".repeat(64),
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
        statement: "The result satisfies its exact acceptance contract.",
        criterionSha256: canonicalJsonSha256({
          statement: "The result satisfies its exact acceptance contract.",
        }),
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
      runtimeAssignment: verifierRuntimeAssignment(),
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
