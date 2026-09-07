import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  issueDelegatedA2ATokenV1,
  openDelegatedA2ATokenV1,
} from "@/lib/a2a/delegated-token";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { buildDelegationTaskV1, transitionDelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";

const originalKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;

describe("A2A delegated tool token", () => {
  beforeEach(() => {
    process.env.OMNIAGENT_CREDENTIAL_KEYRING = JSON.stringify({
      activeKeyId: "test-key",
      keys: { "test-key": Buffer.alloc(32, 7).toString("base64url") },
    });
  });

  afterEach(() => {
    if (originalKeyring === undefined) {
      delete process.env.OMNIAGENT_CREDENTIAL_KEYRING;
    } else {
      process.env.OMNIAGENT_CREDENTIAL_KEYRING = originalKeyring;
    }
  });

  it("issues an opaque, short-lived token bound to task, peer, and exact grants", () => {
    const contract = buildContract();
    const issued = issueDelegatedA2ATokenV1({
      contract,
      internalTask: workingTask(contract),
      rollout: activeRollout(),
      parentExecutionScope,
      issuedAt: "2026-09-07T06:00:30.000Z",
    });

    expect(issued.token).toMatch(/^asael_dpt1\.[A-Za-z0-9_-]+$/);
    expect(issued.token).not.toContain(contract.delegationId);
    expect(issued.envelope).toMatchObject({
      audience: "asael-a2a-delegated-tool-gateway",
      internalTaskId: `delegation-task:${contract.delegationId}`,
      rolloutId: activeRollout().rolloutId,
      expiresAt: "2026-09-07T06:05:00.000Z",
      credentialMaterialIncluded: false,
      principal: {
        delegationId: contract.delegationId,
        governedToolIds: contract.grants.governedToolIds,
        credentialMaterialIncluded: false,
      },
    });
    expect(openDelegatedA2ATokenV1(issued.token, {
      now: "2026-09-07T06:01:00.000Z",
    })).toEqual(issued.envelope);
  });

  it("rejects expiration, tampering, inactive peers, and non-active tasks", () => {
    const contract = buildContract();
    const issued = issueDelegatedA2ATokenV1({
      contract,
      internalTask: workingTask(contract),
      rollout: activeRollout(),
      parentExecutionScope,
      issuedAt: "2026-09-07T06:00:30.000Z",
    });
    expect(() => openDelegatedA2ATokenV1(issued.token, {
      now: issued.envelope.expiresAt,
    })).toThrow(/invalid or expired/i);
    expect(() => openDelegatedA2ATokenV1(`${issued.token.slice(0, -1)}x`, {
      now: "2026-09-07T06:01:00.000Z",
    })).toThrow(/invalid or expired/i);
    expect(() => issueDelegatedA2ATokenV1({
      contract,
      internalTask: buildDelegationTaskV1(contract),
      rollout: activeRollout(),
      parentExecutionScope,
      issuedAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/active canonical task/i);
    expect(() => issueDelegatedA2ATokenV1({
      contract,
      internalTask: workingTask(contract),
      rollout: buildRollout(),
      parentExecutionScope,
      issuedAt: "2026-09-07T06:00:30.000Z",
    })).toThrow(/not enabled and active/i);
  });
});

function workingTask(contract: ReturnType<typeof buildContract>) {
  const proposed = buildDelegationTaskV1(contract);
  const accepted = transitionDelegationTaskV1({
    task: proposed,
    transition: { to: "accepted" },
    at: "2026-09-07T06:00:10.000Z",
  }).task;
  return transitionDelegationTaskV1({
    task: accepted,
    transition: { to: "working" },
    at: "2026-09-07T06:00:20.000Z",
  }).task;
}

function buildRollout() {
  return buildA2APeerRolloutV1({
    tenantId: "tenant-one",
    ownerActorId: "actor-one",
    peerId: "peer:one",
    generation: 1,
    direction: "outbound",
    mode: "enabled",
    interfaceUrl: "https://peer.example/a2a/",
    agentCardSha256: "a".repeat(64),
    outboundCredentialConfigured: true,
    allowedSkillIds: ["peer.verify"],
    createdAt: "2026-09-07T06:00:00.000Z",
  });
}

function activeRollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildRollout(),
    to: "active",
    at: "2026-09-07T06:00:01.000Z",
  });
}

const parentExecutionScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-one",
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  purpose: "agent.run",
});
