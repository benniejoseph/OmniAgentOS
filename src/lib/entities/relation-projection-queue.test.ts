import { afterEach, describe, expect, it, vi } from "vitest";

import { queueTemporalRelationProjection } from "@/lib/entities/relation-projection-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("temporal relation projection queue scope", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps file mode side-effect free after validating the exact owner", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: scope("actor-queue"),
    })).resolves.toEqual({
      queued: false,
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      generation: "0",
    });
  });

  it("rejects a sibling actor and an unbound system caller", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-other",
      executionScope: scope("actor-queue"),
    })).rejects.toThrow("exact owner scope");
    await expect(queueTemporalRelationProjection({
      tenantId: "tenant-queue",
      ownerActorId: "actor-queue",
      executionScope: createExecutionScope({
        tenantId: "tenant-queue",
        initiatingActorId: "actor-queue",
        executingPrincipalType: "system",
        executingPrincipalId: "projector",
        correlationId: "queue-test",
        purpose: "entity.relation.project.v1",
      }),
    })).rejects.toThrow("exact owner scope");
  });
});

function scope(actorId: string) {
  return createExecutionScope({
    tenantId: "tenant-queue",
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: "queue-test",
    purpose: "api.memory.write",
  });
}
