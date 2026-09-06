import { describe, expect, it } from "vitest";

import { buildAgentPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import {
  agentMemoryGrantArtifactV1Schema,
  agentMemoryGrantTargetMemoryId,
  buildAgentMemoryGrantArtifactV1,
} from "@/lib/memory/agent-memory-grant";
import type { MemoryRecord } from "@/lib/memory/types";

const tenantId = "tenant:alpha";
const ownerActorId = "actor:owner";
const sourceAgentId = "agent:atlas";
const targetAgentId = "agent:scout";
const sharedAt = "2026-09-07T00:00:00.000Z";
const sourceBinding = buildAgentPrivateMemoryAccessBindingV1({
  tenantId,
  ownerActorId,
  ownerAgentId: sourceAgentId,
  originPurpose: "memory.verified_effect",
  accessBoundAt: "2026-09-06T00:00:00.000Z",
});
const sourceMemory: MemoryRecord = {
  id: "memory:verified-effect",
  tenantId,
  type: "episode",
  tier: "episodic",
  title: "Verified deployment",
  content: "The deployment target matched the expected release.",
  tags: ["verified-effect"],
  scope: "user",
  source: "effect-receipt",
  importance: 0.8,
  confidence: 1,
  claimStatus: "active",
  assertedBy: "system",
  evidenceRefs: ["run:one", "tool-execution:one", "effect-receipt:one"],
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  accessBinding: sourceBinding,
};

describe("agent memory grant artifact v1", () => {
  it("pins immutable source and target provenance without copying content", () => {
    const targetMemoryId = agentMemoryGrantTargetMemoryId({
      tenantId,
      ownerActorId,
      sourceAgentId,
      sourceMemoryId: sourceMemory.id,
      targetAgentId,
      idempotencyKey: "share-request-one",
    });
    const targetAccessBinding = buildAgentPrivateMemoryAccessBindingV1({
      tenantId,
      ownerActorId,
      ownerAgentId: targetAgentId,
      originPurpose: "memory.agent_private.share",
      accessBoundAt: sharedAt,
    });
    const artifact = buildAgentMemoryGrantArtifactV1({
      tenantId,
      ownerActorId,
      sourceAgentId,
      sourceMemory,
      targetAgentId,
      targetMemoryId,
      targetAccessBinding,
      idempotencyKey: "share-request-one",
      createdAt: sharedAt,
    });

    expect(agentMemoryGrantArtifactV1Schema.parse(artifact)).toEqual(artifact);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact).toMatchObject({
      sourceMemoryId: sourceMemory.id,
      targetAgentId,
      targetMemoryId,
      sourceAccessScopeSha256: sourceBinding.accessScopeSha256,
      targetAccessScopeSha256: targetAccessBinding.accessScopeSha256,
    });
    expect(JSON.stringify(artifact)).not.toContain(sourceMemory.content);
    expect(agentMemoryGrantArtifactV1Schema.safeParse({
      ...artifact,
      targetAgentId: "agent:sentinel",
    }).success).toBe(false);
    expect(() => buildAgentMemoryGrantArtifactV1({
      tenantId,
      ownerActorId,
      sourceAgentId,
      sourceMemory,
      targetAgentId: "agent:sentinel",
      targetMemoryId,
      targetAccessBinding,
      idempotencyKey: "share-request-one",
      createdAt: sharedAt,
    })).toThrow("coordinates are inconsistent");
  });
});
