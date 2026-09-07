import { describe, expect, it } from "vitest";

import {
  buildA2ATaskMappingV1,
  parseA2ATaskMappingV1,
} from "@/lib/a2a/task-mapping";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("A2A task mapping", () => {
  it("binds external coordinates to one canonical internal delegation", () => {
    const mapping = buildA2ATaskMappingV1(mappingInput());
    expect(mapping.mappingId).toMatch(/^a2a-task-map:[a-f0-9]{64}$/);
    expect(mapping.externalTaskId).toBe("remote-task:1");
    expect(mapping.internalTaskId).toBe("delegation-task:one");
    expect(Object.isFrozen(mapping)).toBe(true);
  });

  it("rejects changed external, internal, peer, and rollout bindings", () => {
    const mapping = buildA2ATaskMappingV1(mappingInput());
    for (const change of [
      { externalContextId: "context:other" },
      { internalDelegationId: "delegation:other" },
      { peerId: "peer:other" },
      { rolloutSha256: "d".repeat(64) },
    ]) {
      expect(() => parseA2ATaskMappingV1({ ...mapping, ...change })).toThrow();
    }
  });

  it("rejects a rehashed mapping whose stable identity no longer matches", () => {
    const mapping = buildA2ATaskMappingV1(mappingInput());
    const { mappingId, mappingSha256: _sha, ...body } = mapping;
    const changed = { ...body, externalTaskId: "remote-task:other" };
    expect(() => parseA2ATaskMappingV1({
      ...changed,
      mappingId,
      mappingSha256: canonicalJsonSha256(changed),
    })).toThrow(/integrity/i);
  });
});

function mappingInput() {
  return {
    tenantId: "tenant:1",
    ownerActorId: "actor:1",
    peerId: "peer:1",
    rolloutId: `a2a-rollout:${"a".repeat(64)}`,
    rolloutSha256: "b".repeat(64),
    direction: "inbound" as const,
    externalTaskId: "remote-task:1",
    externalContextId: "context:1",
    internalTaskId: "delegation-task:one",
    internalDelegationId: "delegation:one",
    internalContractSha256: "c".repeat(64),
    localAgentId: "scout" as const,
    localAgentDefinitionVersion: 1,
    remoteSkillId: "skill:research",
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}
