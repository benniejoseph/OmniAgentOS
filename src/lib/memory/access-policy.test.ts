import { describe, expect, it } from "vitest";
import { selectVisibleMemoryDescriptors } from "@/lib/memory/access-policy";
import { createExecutionScope } from "@/lib/security/execution-scope";

const scope = createExecutionScope({
  tenantId: "tenant:alpha",
  initiatingActorId: "actor:owner",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:asael",
  correlationId: "correlation:scope-test",
  contextGrantIds: ["grant:shared"],
  purpose: "test.memory.read",
});

describe("memory access policy", () => {
  it("selects only actor-private and explicitly granted records", () => {
    const result = selectVisibleMemoryDescriptors(scope, [
      { id: "memory:own", tenantId: "tenant:alpha", ownerActorId: "actor:owner", visibility: "private" },
      { id: "memory:shared", tenantId: "tenant:alpha", ownerActorId: "actor:collaborator", visibility: "grant:grant:shared" },
      { id: "memory:sibling", tenantId: "tenant:alpha", ownerActorId: "actor:collaborator", visibility: "private" },
      { id: "memory:other", tenantId: "tenant:beta", ownerActorId: "actor:owner", visibility: "private" },
    ]);

    expect(result.visible.map((record) => record.id)).toEqual(["memory:own", "memory:shared"]);
    expect(result.deniedIds).toEqual(["memory:sibling", "memory:other"]);
    expect(result.invalidRecordCount).toBe(0);
  });

  it("denies malformed records and fails closed on duplicate identities", () => {
    expect(selectVisibleMemoryDescriptors(scope, [
      { id: "memory:unknown", tenantId: "tenant:alpha", ownerActorId: "actor:owner", visibility: "workspace" },
      { id: "memory:extra", tenantId: "tenant:alpha", ownerActorId: "actor:owner", visibility: "private", content: "must not enter policy input" },
    ])).toMatchObject({ visible: [], deniedIds: [], invalidRecordCount: 2 });

    expect(() => selectVisibleMemoryDescriptors(scope, [
      { id: "memory:one", tenantId: "tenant:alpha", ownerActorId: "actor:owner", visibility: "private" },
      { id: "memory:one", tenantId: "tenant:alpha", ownerActorId: "actor:owner", visibility: "private" },
    ])).toThrow(/unique IDs/);
  });

  it("does not infer private ownership when the initiating actor is absent", () => {
    const systemScope = createExecutionScope({
      tenantId: "tenant:alpha",
      initiatingActorId: null,
      executingPrincipalType: "system",
      executingPrincipalId: "principal:worker",
      correlationId: "correlation:system",
      purpose: "test.memory.system-read",
    });
    expect(selectVisibleMemoryDescriptors(systemScope, [{
      id: "memory:private",
      tenantId: "tenant:alpha",
      ownerActorId: "actor:owner",
      visibility: "private",
    }]).visible).toEqual([]);
  });
});
