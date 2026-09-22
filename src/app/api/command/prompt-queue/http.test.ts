import { describe, expect, it } from "vitest";

import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";
import { PromptQueueStoreError } from "@/lib/command/prompt-queue-store";
import type { SecurityContext } from "@/lib/security/types";

const userId = "11111111-1111-4111-8111-111111111111";
const legacyActorId = "queue-owner@example.test";
const canonicalActorId = `actor:${userId}`;
const sessionContext: SecurityContext = {
  tenantId: "tenant-queue",
  actorId: legacyActorId,
  role: "operator",
  source: "session",
  auth: {
    userId,
    email: legacyActorId,
    sessionId: "session-queue",
    tenantName: "Queue tenant",
  },
};

describe("prompt queue request authority", () => {
  it("binds browser-session ownership and execution attribution to the canonical actor", () => {
    const authority = promptQueueAuthority(
      sessionContext,
      "prompt_queue.create",
      "queue-item",
    );

    expect(authority).toMatchObject({
      tenantId: sessionContext.tenantId,
      ownerActorId: canonicalActorId,
      requestActorId: legacyActorId,
      sessionId: sessionContext.auth?.sessionId,
      executionScope: {
        tenantId: sessionContext.tenantId,
        initiatingActorId: canonicalActorId,
        executingPrincipalType: "user",
        executingPrincipalId: canonicalActorId,
        causationId: "queue-item",
        purpose: "prompt_queue.create",
      },
    });
    expect(authority.executionScope.correlationId).toMatch(
      /^prompt-queue:queue-item:/,
    );
  });

  it("uses the same canonical owner for an authenticated native session", () => {
    const authority = promptQueueAuthority({
      ...sessionContext,
      source: "mobile",
      native: {
        deviceId: "device-queue",
        platform: "macos",
        clientContractVersion: 25,
      },
    }, "prompt_queue.list");

    expect(authority.ownerActorId).toBe(canonicalActorId);
    expect(authority.requestActorId).toBe(legacyActorId);
    expect(authority.sessionId).toBe("session-queue");
    expect(authority.executionScope).toMatchObject({
      initiatingActorId: canonicalActorId,
      executingPrincipalId: canonicalActorId,
      causationId: null,
      purpose: "prompt_queue.list",
    });
  });

  it("rejects an authenticated context without a current session", async () => {
    const invoke = () => promptQueueAuthority({
      ...sessionContext,
      auth: { ...sessionContext.auth!, sessionId: "   " },
    }, "prompt_queue.create");

    expect(invoke).toThrowError(PromptQueueStoreError);
    try {
      invoke();
    } catch (error) {
      const response = promptQueueErrorResponse(error);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: "conflict",
        message: "A current authenticated session is required for prompt queue changes.",
      });
    }
  });

  it("fails closed when the request has no canonical authenticated actor", async () => {
    const invoke = () => promptQueueAuthority({
      ...sessionContext,
      source: "headers",
    }, "prompt_queue.create");

    expect(invoke).toThrowError(PromptQueueStoreError);
    try {
      invoke();
    } catch (error) {
      const response = promptQueueErrorResponse(error);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "conflict",
        message: "A canonical authenticated account is required for prompt queue changes.",
      });
    }
  });
});
