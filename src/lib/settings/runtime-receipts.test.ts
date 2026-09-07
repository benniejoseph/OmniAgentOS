import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
  listFileAiUsageRecords: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));
vi.mock("@/lib/usage/ledger", () => ({
  listFileAiUsageRecords: mocks.listFileAiUsageRecords,
}));

import { listModelAssignmentRuntimeReceipts } from "@/lib/settings/runtime-receipts";
import type { RequestModelAssignment } from "@/lib/settings/types";

const assignment: RequestModelAssignment = {
  id: "assignment-planner",
  tenantId: "tenant-a",
  actorId: "actor-a",
  scope: "planner",
  provider: "openai",
  modelId: "gpt-5.2",
  displayModelId: "gpt-5.2",
  allowCrossProviderFallback: false,
  runtimeReadiness: "active",
  runtimeNote: "active",
  contractVersion: "p11.8-model-assignment:1",
  revision: 7,
  configurationSha256: "b".repeat(64),
  validatedAt: "2026-09-07T12:00:00.000Z",
  createdAt: "2026-09-07T11:00:00.000Z",
  updatedAt: "2026-09-07T12:00:00.000Z",
  manageable: true,
};

beforeEach(() => {
  mocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
  mocks.listFileAiUsageRecords.mockReset();
});

describe("model assignment runtime receipts", () => {
  it("returns only exact current-revision tenant-vault evidence", async () => {
    mocks.listFileAiUsageRecords.mockResolvedValue([
      usageRow({ assignmentRevision: 6 }),
      usageRow({ actorId: "other-actor" }),
      usageRow({
        provider: "anthropic",
        model: "claude-sonnet",
        callReceipts: [
          { status: "failed" },
          { status: "completed" },
        ],
      }),
    ]);

    await expect(listModelAssignmentRuntimeReceipts({
      tenantId: "tenant-a",
      actorId: "actor-a",
      assignments: [assignment],
    })).resolves.toEqual([{
      scope: "planner",
      assignmentId: "assignment-planner",
      assignmentRevision: 7,
      assignmentConfigurationSha256: "b".repeat(64),
      state: "succeeded",
      provider: "anthropic",
      model: "claude-sonnet",
      fallbackUsed: true,
      credentialSource: "tenant_vault",
      recordedAt: "2026-09-07T12:30:00.000Z",
    }]);
  });

  it("does not present environment or legacy activity as an assignment receipt", async () => {
    mocks.listFileAiUsageRecords.mockResolvedValue([
      usageRow({ credentialSource: "deployment_environment" }),
    ]);

    await expect(listModelAssignmentRuntimeReceipts({
      tenantId: "tenant-a",
      actorId: "actor-a",
      assignments: [
        assignment,
        { ...assignment, id: "legacy", scope: "verifier", contractVersion: "legacy", runtimeReadiness: "configuration_only", configurationSha256: undefined, validatedAt: undefined },
      ],
    })).resolves.toEqual([]);
  });
});

function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    actorId: "actor-a",
    assignmentId: "assignment-planner",
    assignmentScope: "planner",
    assignmentRevision: 7,
    assignmentConfigurationSha256: "b".repeat(64),
    credentialSource: "tenant_vault",
    status: "completed",
    provider: "openai",
    model: "gpt-5.2",
    callReceipts: [],
    recordedAt: "2026-09-07T12:30:00.000Z",
    ...overrides,
  };
}
