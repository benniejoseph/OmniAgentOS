import { describe, expect, it } from "vitest";

import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  A2AProtocolError,
  a2aArtifactV1Schema,
  a2aMessageV1Schema,
  assertA2AProtocolVersion,
  buildAsaelA2AAgentCardV1,
  delegationStateToA2AState,
  parseA2AAgentCardV1,
} from "@/lib/a2a/v1-contracts";

describe("A2A 1.0 boundary contracts", () => {
  it("pins the reviewed protocol and media type", () => {
    expect(A2A_PROTOCOL_VERSION).toBe("1.0");
    expect(A2A_MEDIA_TYPE).toBe("application/a2a+json");
  });

  it("rejects missing, legacy, and unsupported protocol versions", () => {
    for (const version of [undefined, "", "0.3", "1.1", "2.0"]) {
      const headers = new Headers();
      if (version !== undefined) headers.set("A2A-Version", version);
      expect(() => assertA2AProtocolVersion(new Request("https://asael.test/api/a2a", {
        headers,
      }))).toThrow(A2AProtocolError);
    }
    expect(assertA2AProtocolVersion(new Request("https://asael.test/api/a2a", {
      headers: { "A2A-Version": "1.0" },
    }))).toBe("1.0");
  });

  it("accepts bounded text and structured messages", () => {
    expect(a2aMessageV1Schema.parse({
      messageId: "message:1",
      role: "ROLE_USER",
      parts: [
        { text: "Prepare a verified summary.", mediaType: "text/plain" },
        { data: { artifactId: "artifact:1" }, mediaType: "application/json" },
      ],
    }).parts).toHaveLength(2);
  });

  it("rejects ambiguous, binary, remote-url, oversized, and credential-shaped wire content", () => {
    expect(() => a2aMessageV1Schema.parse({
      messageId: "message:1",
      role: "ROLE_USER",
      parts: [{ text: "one", data: { two: true } }],
    })).toThrow();
    expect(() => a2aMessageV1Schema.parse({
      messageId: "message:1",
      role: "ROLE_USER",
      parts: [{ raw: "c2VjcmV0" }],
    })).toThrow();
    expect(() => a2aMessageV1Schema.parse({
      messageId: "message:1",
      role: "ROLE_USER",
      parts: [{ url: "https://untrusted.example/file" }],
    })).toThrow();
    expect(() => a2aArtifactV1Schema.parse({
      artifactId: "artifact:1",
      parts: [{ text: "x".repeat(32_001) }],
    })).toThrow();
  });

  it("publishes a minimal card without internal identity or authority", () => {
    const card = buildAsaelA2AAgentCardV1({
      baseUrl: "https://asael.example/app",
      releaseVersion: "p8.6-a2a-adapter:1",
    });
    expect(card.supportedInterfaces).toEqual([{
      url: "https://asael.example/app/api/a2a/",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    }]);
    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: true,
    });
    expect(JSON.stringify(card)).not.toMatch(
      /tenantId|actorId|principalId|grantIds|credential|cardSha256|definitionSha256/,
    );
    expect(parseA2AAgentCardV1(card)).toEqual(card);
    expect(Object.isFrozen(card)).toBe(true);
  });

  it("does not report a remote completion until parent acceptance", () => {
    expect(delegationStateToA2AState("completed_proposed")).toBe(
      "TASK_STATE_WORKING",
    );
    expect(delegationStateToA2AState("result_accepted")).toBe(
      "TASK_STATE_COMPLETED",
    );
    expect(delegationStateToA2AState("canceled")).toBe(
      "TASK_STATE_CANCELED",
    );
  });
});
