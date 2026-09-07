import { describe, expect, it } from "vitest";

import {
  A2A_ADAPTER_ARTIFACT_SHA256,
  A2A_ADAPTER_RELEASE,
  assertA2APeerRolloutActive,
  buildA2APeerRolloutV1,
  parseA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("A2A peer rollout", () => {
  it("pins exact peer, interface, card, adapter release, and artifact", () => {
    const rollout = peerRollout();
    expect(rollout.adapterRelease).toBe(A2A_ADAPTER_RELEASE);
    expect(rollout.adapterArtifactSha256).toBe(
      A2A_ADAPTER_ARTIFACT_SHA256,
    );
    expect(rollout.protocolVersion).toBe("1.0");
    expect(rollout.interfaceUrl).toBe("https://peer.example/a2a/");
    expect(Object.isFrozen(rollout)).toBe(true);
  });

  it("requires exact inbound and outbound credential bindings", () => {
    expect(() => buildA2APeerRolloutV1({
      ...peerInput(),
      inboundServiceApiKeyId: null,
    })).toThrow(/inbound rollouts require/i);
    expect(() => buildA2APeerRolloutV1({
      ...peerInput(),
      outboundCredentialConfigured: false,
    })).toThrow(/outbound rollouts require/i);
  });

  it("rejects non-HTTPS interfaces and embedded credentials", () => {
    for (const interfaceUrl of [
      "http://peer.example/a2a",
      "https://user:secret@peer.example/a2a",
    ]) {
      expect(() => buildA2APeerRolloutV1({
        ...peerInput(),
        interfaceUrl,
      })).toThrow(/credential-free HTTPS/i);
    }
  });

  it("fails closed until an enabled rollout is active and caller-bound", () => {
    const registered = peerRollout();
    expect(() => assertA2APeerRolloutActive({
      rollout: registered,
      direction: "inbound",
      serviceApiKeyId: "key:1",
    })).toThrow(/not enabled and active/i);
    const shadow = transitionA2APeerRolloutV1({
      rollout: buildA2APeerRolloutV1({ ...peerInput(), mode: "shadow" }),
      to: "active",
    });
    expect(() => assertA2APeerRolloutActive({
      rollout: shadow,
      direction: "inbound",
      serviceApiKeyId: "key:1",
    })).toThrow(/not enabled and active/i);
    const active = transitionA2APeerRolloutV1({ rollout: registered, to: "active" });
    expect(() => assertA2APeerRolloutActive({
      rollout: active,
      direction: "inbound",
      serviceApiKeyId: "key:other",
    })).toThrow(/not bound/i);
    expect(assertA2APeerRolloutActive({
      rollout: active,
      direction: "inbound",
      serviceApiKeyId: "key:1",
    })).toEqual(active);
  });

  it("supports only revisioned pause, resume, and terminal revocation", () => {
    const active = transitionA2APeerRolloutV1({ rollout: peerRollout(), to: "active" });
    const paused = transitionA2APeerRolloutV1({ rollout: active, to: "paused" });
    const resumed = transitionA2APeerRolloutV1({ rollout: paused, to: "active" });
    const revoked = transitionA2APeerRolloutV1({ rollout: resumed, to: "revoked" });
    expect(revoked.lifecycleRevision).toBe(4);
    expect(() => transitionA2APeerRolloutV1({
      rollout: revoked,
      to: "active",
    })).toThrow(/invalid/i);
  });

  it("rejects a rehashed rollout that changes the reviewed adapter pin", () => {
    const rollout = peerRollout();
    const { rolloutId: _id, rolloutSha256: _sha, ...body } = rollout;
    const changed = { ...body, adapterRelease: "latest" };
    const rolloutSha256 = canonicalJsonSha256(changed);
    expect(() => parseA2APeerRolloutV1({
      ...changed,
      rolloutId: `a2a-rollout:${rolloutSha256}`,
      rolloutSha256,
    })).toThrow();
  });
});

function peerInput() {
  return {
    tenantId: "tenant:1",
    ownerActorId: "actor:1",
    peerId: "peer:1",
    generation: 1,
    direction: "bidirectional" as const,
    mode: "enabled" as const,
    interfaceUrl: "https://peer.example/a2a",
    agentCardSha256: "a".repeat(64),
    inboundServiceApiKeyId: "key:1",
    outboundCredentialConfigured: true,
    allowedSkillIds: ["skill:research"],
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}

function peerRollout() {
  return buildA2APeerRolloutV1(peerInput());
}
