import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  canonical: vi.fn(),
  resolveOwner: vi.fn(),
  resolve: vi.fn(),
  append: vi.fn(),
  observeRate: vi.fn(),
  home: vi.fn(),
}));

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: mocks.canonical,
}));
vi.mock("@/lib/moltbook/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/moltbook/store")>(),
  resolveMoltbookAgentOwner: mocks.resolveOwner,
  resolveMoltbookConnectionForTool: mocks.resolve,
  appendMoltbookToolActivity: mocks.append,
  observeMoltbookRateLimit: mocks.observeRate,
}));
vi.mock("@/lib/moltbook/http-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/moltbook/http-client")>(),
  createMoltbookClient: () => ({ home: mocks.home }),
}));

import { executeMoltbookToolAction } from "@/lib/moltbook/tool-actions";

const context = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canonical.mockReturnValue({
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
    readableOwnerActorIds: [
      "actor:11111111-1111-4111-8111-111111111111",
      "owner@example.test",
    ],
  });
  mocks.resolveOwner.mockResolvedValue({
    tenantId: "tenant-one",
    actorId: "owner@example.test",
  });
  mocks.resolve.mockResolvedValue({
    connectionId: `moltbook_connection_${"a".repeat(48)}`,
    tenantId: "tenant-one",
    ownerActorId: "owner@example.test",
    agentId: "agent_molty",
    externalName: "AsaelMolty",
    apiKey: "opaque-provider-key:without-prefix",
  });
  mocks.home.mockResolvedValue({
    data: { your_account: { name: "AsaelMolty" } },
    requestSha256: "b".repeat(64),
    responseSha256: "c".repeat(64),
    statusCode: 200,
  });
});

describe("Moltbook tool owner mapping", () => {
  it("accepts a live email-rooted scope and preserves the stored physical owner", async () => {
    const result = await executeMoltbookToolAction({
      toolId: "moltbook.home.read",
      toolInput: {},
      context,
      executionScope: scope("owner@example.test"),
      toolExecutionId: "tool_execution_one",
    });
    expect(result).toMatchObject({ source: "moltbook", untrusted: true });
    expect(mocks.resolveOwner).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      agentId: "agent_molty",
      readableOwnerActorIds: [
        "actor:11111111-1111-4111-8111-111111111111",
        "owner@example.test",
      ],
    });
    expect(mocks.resolve).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      ownerActorId: "owner@example.test",
      executingAgentId: "agent_molty",
    });
  });

  it("fails closed when the initiating request actor does not match the run", async () => {
    await expect(executeMoltbookToolAction({
      toolId: "moltbook.home.read",
      toolInput: {},
      context,
      executionScope: scope("other@example.test"),
      toolExecutionId: "tool_execution_two",
    })).rejects.toThrow("authority does not match");
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

function scope(initiatingActorId: string) {
  return createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "agent_molty",
    correlationId: "moltbook-correlation",
    purpose: "moltbook.home.read",
  });
}
