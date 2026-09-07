import { describe, expect, it } from "vitest";

import {
  buildInternalAgentCardV1,
  listInternalAgentCardsV1,
  parseInternalAgentCardV1,
} from "@/lib/agents/discovery-card";

describe("P8.5 internal Agent Card", () => {
  it("advertises versioned capabilities, schemas, modalities, auth needs, and limits", () => {
    const card = buildInternalAgentCardV1({
      agentId: "scout",
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });

    expect(card).toMatchObject({
      version: "p8.5-agent-card:1",
      publicationState: "internal_only",
      externalA2AEnabled: false,
      logicalAgentId: "scout",
      authentication: {
        required: true,
        scheme: "delegated_principal",
        audience: "governed_orchestrator",
        credentialForwarding: false,
      },
      protocols: {
        task: "p8.3-delegation-task:1",
        message: "p8.4-delegation-message:1",
        artifact: "p8.4-shared-mission-artifact:1",
      },
      limits: { maxFanOut: 0, maxOutputArtifacts: 8 },
    });
    expect(card.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKinds: ["research"], toolPolicy: "read_only" }),
    ]));
    expect(card.capabilities.every((capability) =>
      capability.inputSchemaSha256.length === 64 &&
      capability.outputSchemaSha256.length === 64
    )).toBe(true);
    expect(Object.isFrozen(card.capabilities)).toBe(true);
  });

  it("contains no owner, principal, endpoint, grant, budget authority, or credential", () => {
    const serialized = JSON.stringify(buildInternalAgentCardV1({
      agentId: "forge",
      tenantId: "private-tenant",
      controllerActorId: "private-actor",
    }));
    for (const forbidden of [
      "private-tenant",
      "private-actor",
      "principalId",
      "endpoint",
      "contextGrantIds",
      "capabilityGrantIds",
      "toolGrantIds",
      "password",
      "token",
      "secret",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("detects mutation and projects every internal Agent deterministically", () => {
    const cards = listInternalAgentCardsV1({
      tenantId: "tenant-one",
      controllerActorId: "actor-one",
    });
    expect(cards.map((card) => card.logicalAgentId)).toEqual([
      "atlas",
      "scout",
      "forge",
      "sentinel",
      "mnemosyne",
    ]);
    const tampered = JSON.parse(JSON.stringify(cards[0]));
    tampered.limits.maxFanOut = 16;
    expect(() => parseInternalAgentCardV1(tampered)).toThrow(/integrity/i);
  });
});
