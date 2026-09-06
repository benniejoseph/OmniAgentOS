import { describe, expect, it } from "vitest";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import {
  memoryScopePresentation,
  portableArchiveFilename,
} from "@/components/memory-workspace-utils";

describe("memory workspace presentation", () => {
  it("explains an actor-bound private memory in plain language", () => {
    const accessBinding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant_test",
      ownerActorId: "actor_owner",
      originPurpose: "test.memory.workspace",
    });

    expect(memoryScopePresentation({ scope: "user", accessBinding })).toEqual({
      visibility: "Only you",
      boundary: "Personal",
      sensitivity: "Confidential",
      explanation: "This memory is bound to your account and excluded from sibling users.",
    });
  });

  it("labels older records without inventing an owner binding", () => {
    expect(memoryScopePresentation({ scope: "workspace" })).toEqual({
      visibility: "Legacy compatibility",
      boundary: "Workspace",
      sensitivity: "Not classified",
      explanation: "This older memory keeps its original compatibility scope.",
    });
  });

  it("uses the verified archive filename and a versioned fallback", () => {
    expect(portableArchiveFilename(
      "attachment; filename=asael-2026-09-06-v2.json",
    )).toBe("asael-2026-09-06-v2.json");
    expect(portableArchiveFilename(
      null,
      new Date("2026-09-06T10:00:00.000Z"),
    )).toBe("asael-2026-09-06-v2.json");
  });
});
