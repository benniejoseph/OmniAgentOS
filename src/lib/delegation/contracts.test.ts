import { describe, expect, it } from "vitest";

import {
  buildDelegationContractV1,
  parseDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";

describe("P8.1 DelegationContract", () => {
  it("binds a bounded, cancelable, independently verifiable subtask", () => {
    const contract = build();
    expect(contract).toMatchObject({
      version: "p8.1-delegation-contract:1",
      objective: "Verify the governed result against its acceptance criterion.",
      budgets: { agents: 1, modelTurns: 1, retries: 1 },
      cancellation: { cancelable: true },
      verifier: {
        completionDisposition: "proposed_only",
        parentAcceptanceRequired: true,
      },
      dataBoundary: {
        parentTranscriptIncluded: false,
        credentialMaterialIncluded: false,
        inputArtifactsByReferenceOnly: true,
      },
    });
    expect(contract.contractId).toBe(
      `delegation-contract:${contract.contractSha256}`,
    );
    expect(JSON.stringify(contract)).not.toContain("transcript content");
  });

  it("rejects grant or budget authority absent from the parent", () => {
    expect(() => build({
      grants: {
        ...grants,
        capabilityGrantIds: ["grant:capability:other"],
      },
    })).toThrow(/cannot exceed parent authority/);
    expect(() => build({ budgets: { ...childBudgets, toolCalls: 11 } }))
      .toThrow(/toolCalls budget cannot exceed parent authority/);
  });

  it("rejects deadline and retry expansion", () => {
    expect(() => build({
      deadline: {
        createdAt: "2026-09-07T06:00:00.000Z",
        acceptBy: "2026-09-07T06:01:00.000Z",
        completeBy: "2026-09-07T07:01:00.000Z",
      },
    })).toThrow(/deadline cannot exceed/);
    expect(() => build({
      retry: {
        ...retry,
        maxAttempts: 3,
        backoffMs: [250, 1_000],
      },
    })).toThrow(/retry and Agent budgets are inconsistent/);
  });

  it("rejects credential material and open or sensitive output schemas", () => {
    expect(() => build({ objective: "Verify this result. password=supersecretvalue" }))
      .toThrow(/credential material/);
    expect(() => build({
      output: {
        ...output,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { accessToken: { type: "string" } },
        },
      },
    })).toThrow(/not closed and bounded|credential material/);
    expect(() => build({
      output: {
        ...output,
        schema: { type: "object", additionalProperties: true },
      },
    })).toThrow(/not closed and bounded/);
  });

  it("rejects any post-construction mutation", () => {
    const contract = build();
    expect(() => parseDelegationContractV1({
      ...contract,
      objective: "Silently widened objective.",
    })).toThrow(/integrity/);
  });
});

const grants: DelegationContractV1["grants"] = {
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  governedToolIds: ["knowledge.search"],
  connectorTargets: [],
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

const retry: DelegationContractV1["retry"] = {
  maxAttempts: 2,
  backoffMs: [250],
  retryableReasons: ["transient_provider" as const],
  neverRetryReasons: [
    "authority_denied",
    "contract_invalid",
    "canceled",
    "deadline_expired",
  ],
};

const output: Omit<DelegationContractV1["output"], "schemaSha256"> = {
  schemaId: "workflow-node-result",
  schemaVersion: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["completed", "blocked"] },
    },
  },
  artifactKinds: ["verification" as const],
  maxArtifacts: 4,
  maxBytes: 12_000,
};

function build(overrides: Partial<Parameters<typeof buildDelegationContractV1>[0]> = {}) {
  return buildDelegationContractV1({
    delegationId: "delegation:one",
    scope: {
      tenantId: "tenant-one",
      initiatingActorId: "actor-one",
      parentExecutionId: "run-one",
      parentDelegationId: null,
      workspaceId: null,
      projectId: null,
      missionId: null,
      correlationSha256: "a".repeat(64),
    },
    delegator: {
      principalId: "principal:atlas:1",
      agentId: "atlas",
      definitionVersion: 1,
    },
    delegate: { agentId: "sentinel", definitionVersion: 1 },
    objective: "Verify the governed result against its acceptance criterion.",
    acceptanceCriteria: [{
      criterionId: "criterion:one",
      statement: "The result is supported by its governed receipt.",
      verificationMethod: "governed_receipt",
      required: true,
    }],
    inputArtifacts: [{
      artifactId: "artifact:one",
      sourceExecutionId: "execution:one",
      name: "governed result",
      kind: "result",
      mediaType: "text/plain",
      contentSha256: "b".repeat(64),
      byteCount: 42,
      evidenceIds: ["tool-execution:one"],
    }],
    output,
    grants,
    parentAuthority: {
      grants,
      budgets: parentBudgets,
      completeBy: "2026-09-07T07:00:00.000Z",
    },
    budgets: childBudgets,
    deadline: {
      createdAt: "2026-09-07T06:00:00.000Z",
      acceptBy: "2026-09-07T06:01:00.000Z",
      completeBy: "2026-09-07T06:05:00.000Z",
    },
    cancellation: {
      cancelable: true,
      signalId: "delegation-signal:one",
      allowedInitiators: ["parent", "owner", "system"],
      acknowledgementDeadlineMs: 5_000,
    },
    retry,
    verifier: {
      agentId: "sentinel",
      definitionVersion: 1,
      method: "deterministic_schema_and_evidence",
      requiredEvidenceKinds: ["artifact_digest", "tool_receipt", "acceptance_check"],
      acceptanceThreshold: 1,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
    ...overrides,
  });
}
