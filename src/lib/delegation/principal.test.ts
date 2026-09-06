import { describe, expect, it } from "vitest";

import {
  buildDelegatedPrincipalV1,
  parseDelegatedPrincipalV1,
} from "@/lib/delegation/principal";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildContract } from "@/lib/delegation/test-fixtures";

describe("P8.2 attenuated delegated principal", () => {
  it("binds the exact contract grants to a non-transferable executor audience", () => {
    const contract = buildContract();
    const principal = buildDelegatedPrincipalV1({
      contract,
      parentExecutionScope,
    });

    expect(principal).toMatchObject({
      version: "p8.2-delegated-principal:1",
      principalId: contract.delegate.principalId,
      delegationId: contract.delegationId,
      delegationContractSha256: contract.contractSha256,
      audience: "asael-governed-tool-executor",
      governedToolIds: contract.grants.governedToolIds,
      canRedelegate: false,
      credentialMaterialIncluded: false,
    });
  });

  it("rejects a different parent scope or mutated principal", () => {
    const contract = buildContract();
    expect(() => buildDelegatedPrincipalV1({
      contract,
      parentExecutionScope: createExecutionScope({
        ...parentScopeInput,
        executingPrincipalId: "principal:other",
      }),
    })).toThrow(/parent execution scope/);
    const principal = buildDelegatedPrincipalV1({ contract, parentExecutionScope });
    expect(() => parseDelegatedPrincipalV1({
      ...principal,
      governedToolIds: ["tool.other"],
    })).toThrow(/integrity/);
  });
});

const parentScopeInput = {
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent" as const,
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-one",
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  purpose: "agent.run",
};
const parentExecutionScope = createExecutionScope(parentScopeInput);
