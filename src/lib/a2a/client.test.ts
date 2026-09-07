import { beforeEach, describe, expect, it, vi } from "vitest";

const networkMocks = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(async (value: string) => value),
  fetchPublicHttpUrl: vi.fn(),
}));

vi.mock("@/lib/security/network", () => networkMocks);

import {
  createA2AClientV1,
  discoverExternalA2APeerV1,
} from "@/lib/a2a/client";
import {
  buildA2APeerRolloutV1,
  transitionA2APeerRolloutV1,
} from "@/lib/a2a/rollout";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("A2A 1.0 client adapter", () => {
  beforeEach(() => {
    networkMocks.assertPublicHttpUrl.mockClear();
    networkMocks.fetchPublicHttpUrl.mockReset();
  });

  it("discovers and digests a compatible public Agent Card", async () => {
    const card = peerCard();
    networkMocks.fetchPublicHttpUrl.mockResolvedValue(jsonResponse(card));
    const discovered = await discoverExternalA2APeerV1({
      baseUrl: "https://peer.example/some/path",
    });
    expect(discovered.cardSha256).toBe(canonicalJsonSha256(card));
    expect(discovered.selectedInterface.url).toBe("https://peer.example/a2a/");
    expect(networkMocks.fetchPublicHttpUrl).toHaveBeenCalledWith(
      "https://peer.example/.well-known/agent-card.json",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
      "A2A Agent Card URL",
    );
  });

  it("sends versioned, authenticated, idempotent task messages", async () => {
    networkMocks.fetchPublicHttpUrl.mockResolvedValue(jsonResponse({
      task: task("TASK_STATE_SUBMITTED"),
    }));
    const client = createA2AClientV1({ rollout: activeRollout(), bearerToken: "peer-token" });
    const result = await client.sendMessage({
      messageId: "message:1",
      role: "ROLE_USER",
      parts: [{ text: "Analyze the scoped artifact.", mediaType: "text/plain" }],
    });
    expect(result.status.state).toBe("TASK_STATE_SUBMITTED");
    const [url, init] = networkMocks.fetchPublicHttpUrl.mock.calls[0];
    expect(url.toString()).toBe("https://peer.example/a2a/message:send");
    expect(new Headers(init.headers)).toMatchObject(expect.any(Headers));
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer peer-token");
    expect(new Headers(init.headers).get("A2A-Version")).toBe("1.0");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("message:1");
  });

  it("gets and cancels only bounded task identifiers", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async () =>
      jsonResponse({ task: task("TASK_STATE_WORKING") })
    );
    const client = createA2AClientV1({ rollout: activeRollout(), bearerToken: "peer-token" });
    await client.getTask("task:1", { historyLength: 10 });
    await client.cancelTask("task:1");
    expect(networkMocks.fetchPublicHttpUrl.mock.calls[0][0].toString()).toBe(
      "https://peer.example/a2a/tasks/task%3A1?historyLength=10",
    );
    expect(networkMocks.fetchPublicHttpUrl.mock.calls[1][0].toString()).toBe(
      "https://peer.example/a2a/tasks/task%3A1:cancel",
    );
    await expect(client.getTask("../secrets")).rejects.toThrow(/identifier/i);
  });

  it("parses bounded SSE task progress", async () => {
    const events = [
      { statusUpdate: { taskId: "task:1", contextId: "context:1", status: { state: "TASK_STATE_WORKING" } } },
      { task: task("TASK_STATE_COMPLETED") },
    ];
    networkMocks.fetchPublicHttpUrl.mockResolvedValue(new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    const client = createA2AClientV1({ rollout: activeRollout(), bearerToken: "peer-token" });
    const received = [];
    for await (const event of client.subscribeToTask("task:1")) received.push(event);
    expect(received.map((event) => event.type)).toEqual(["status", "task"]);
  });

  it("rejects disabled rollouts, invalid credentials, redirects, and oversized responses", async () => {
    const registered = buildA2APeerRolloutV1(rolloutInput());
    expect(() => createA2AClientV1({ rollout: registered, bearerToken: "token" })).toThrow(/not enabled/i);
    expect(() => createA2AClientV1({ rollout: activeRollout(), bearerToken: "bad token" })).toThrow(/Bearer token/i);

    networkMocks.fetchPublicHttpUrl.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example" },
    }));
    const client = createA2AClientV1({ rollout: activeRollout(), bearerToken: "peer-token" });
    await expect(client.getTask("task:1")).rejects.toThrow(/redirects/i);

    networkMocks.fetchPublicHttpUrl.mockResolvedValueOnce(new Response(
      JSON.stringify({ task: task("TASK_STATE_WORKING"), padding: "x".repeat(300_000) }),
    ));
    await expect(client.getTask("task:1")).rejects.toThrow(/byte boundary/i);
  });
});

function peerCard() {
  return {
    name: "Peer",
    description: "A compatible test peer.",
    supportedInterfaces: [{
      url: "https://peer.example/a2a/",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    }],
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
    },
    securityRequirements: [{ bearer: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [{
      id: "skill:research",
      name: "Research",
      description: "Research a bounded question.",
      tags: ["research"],
    }],
  };
}

function task(state: string) {
  return {
    id: "task:1",
    contextId: "context:1",
    status: { state, timestamp: "2026-09-07T00:00:00.000Z" },
  };
}

function rolloutInput() {
  return {
    tenantId: "tenant:1",
    ownerActorId: "actor:1",
    peerId: "peer:1",
    generation: 1,
    direction: "outbound" as const,
    mode: "enabled" as const,
    interfaceUrl: "https://peer.example/a2a/",
    agentCardSha256: canonicalJsonSha256(peerCard()),
    inboundServiceApiKeyId: null,
    outboundCredentialConfigured: true,
    allowedSkillIds: ["skill:research"],
    allowedInboundAgentIds: [],
    maxOutputBytes: 262_144,
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}

function activeRollout() {
  return transitionA2APeerRolloutV1({
    rollout: buildA2APeerRolloutV1(rolloutInput()),
    to: "active",
    at: "2026-09-07T00:00:01.000Z",
  });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/a2a+json" },
  });
}
