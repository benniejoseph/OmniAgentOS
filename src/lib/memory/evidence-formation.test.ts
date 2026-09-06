import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formAssistantInferenceCandidate,
  formExplicitUserAssertionMemory,
  parseExplicitMemoryAssertion,
} from "@/lib/memory/evidence-formation";
import { listStreamEvents } from "@/lib/events/store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { listMemories, searchMemories } from "@/lib/memory/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = {
  tenantId: "tenant-formation",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Formation test",
  },
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-evidence-formation-"),
  );
  delete process.env.DATABASE_URL;
});

describe("evidence-based direct-run memory formation", () => {
  it("parses only explicit remember instructions deterministically", () => {
    expect(parseExplicitMemoryAssertion("Please remember that I prefer concise answers."))
      .toEqual({
        content: "I prefer concise answers.",
        type: "preference",
      });
    expect(parseExplicitMemoryAssertion("Remember: the launch window is Tuesday"))
      .toEqual({
        content: "the launch window is Tuesday",
        type: "fact",
      });
    expect(parseExplicitMemoryAssertion("Could you keep this in mind?"))
      .toBeUndefined();
  });

  it("forms an active private user assertion with a traceable source turn", async () => {
    const record = await formExplicitUserAssertionMemory({
      context,
      requestId: "remember-a",
      threadId: "thread-a",
      turnId: "turn-a",
      message: "Remember that I prefer concise answers.",
    });
    expect(record).toMatchObject({
      type: "preference",
      content: "I prefer concise answers.",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: [
        "thread:thread-a",
        "turn:turn-a",
        "request:remember-a",
      ],
      accessBinding: {
        visibility: "user_private",
        ownerActorId: `actor:${context.auth?.userId}`,
      },
    });
    const events = await listStreamEvents(`memory:${record?.id}`, {
      tenantId: context.tenantId,
    });
    expect(events.map((event) => event.type)).toContain(
      "memory.formation.recorded",
    );
  });

  it("keeps assistant prose private and inactive", async () => {
    const candidate = await formAssistantInferenceCandidate({
      context,
      requestId: "inference-a",
      runId: "run-a",
      threadId: "thread-a",
      response: "A possible conclusion requiring confirmation. ".repeat(10),
    });
    expect(candidate).toMatchObject({
      claimStatus: "candidate",
      assertedBy: "agent",
      source: "assistant-inference",
      accessBinding: { visibility: "user_private" },
    });
    await expect(searchMemories("possible conclusion", {
      tenantId: context.tenantId,
    })).resolves.toEqual([]);

    const access = requestMemoryAccessFromSecurityContext(context, {
      purposeId: MEMORY_PURPOSE_IDS.read,
      auditPurpose: "test.memory.read",
      correlationId: "candidate-read",
    });
    const privateRecords = await listMemories({
      tenantId: context.tenantId,
      includeInactive: true,
      accessScope: access?.databaseAccessScope,
    });
    expect(privateRecords.map((record) => record.id)).toContain(candidate?.id);
  });
});
