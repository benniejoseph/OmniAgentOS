import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  calls: [] as Array<{ text: string; values: unknown[] }>,
  events: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.calls.push({ text: strings.join("?"), values });
      return mocks.responses.shift() || [];
    },
    {
      query: vi.fn(),
      unsafe: vi.fn(),
      transaction: async (operation: (client: unknown) => unknown) => operation(sql),
      transactionScoped: true,
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
  };
});

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.events,
}));

const tenantId = "tenant-template";
const workspaceId = "workspace:personal:11111111-1111-4111-8111-111111111111";
const canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";

function mutationAuthority(purpose: string, idempotencyKey: string) {
  return {
    tenantId,
    workspaceId,
    canonicalActorId,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: "user",
      executingPrincipalId: canonicalActorId,
      workspaceId,
      correlationId: idempotencyKey,
      purpose,
    }),
  };
}

const definition = {
  name: "Release",
  description: "Ship the application.",
  project: {
    title: "Release",
    objective: "Ship safely",
    status: "draft" as const,
    tasks: [{
      key: "verify",
      title: "Verify release",
      detail: "Run the focused checks.",
      priority: "high" as const,
      agentId: "sentinel" as const,
      dependsOnKeys: [],
    }],
  },
  playbook: {
    aliases: ["Run release"],
    mode: "orchestrate" as const,
    toolBindings: [{ toolId: "app.projects.list", input: { limit: 5 } }],
    acceptanceCriteria: ["Focused checks pass."],
  },
};

beforeEach(() => {
  mocks.responses = [];
  mocks.calls = [];
  mocks.events.mockReset().mockResolvedValue({});
});

describe("workspace template store", () => {
  it("publishes immutable monotonic versions and advances only the active channel", async () => {
    const { publishWorkspaceTemplate } = await import("@/lib/workspace-templates/store");
    mocks.responses.push(
      [],
      [],
      [],
      [{ published_at: new Date("2026-09-07T10:00:00.000Z") }],
      [],
      [],
    );
    const first = await publishWorkspaceTemplate({
      authority: mutationAuthority("workspace.template.publish", "publish-1"),
      definition,
    });
    expect(first).toMatchObject({ version: 1, active: true, activeVersion: 1 });
    expect(first.templateVersionId).toBe(`${first.templateId}:v1`);

    mocks.responses.push(
      [],
      [],
      [{ active_template_version: 1, owner_actor_id: canonicalActorId }],
      [{ published_at: new Date("2026-09-07T10:01:00.000Z") }],
      [],
      [],
    );
    const second = await publishWorkspaceTemplate({
      authority: mutationAuthority("workspace.template.publish", "publish-2"),
      definition: { ...definition, templateId: first.templateId, description: "Ship the reviewed application." },
    });
    expect(second).toMatchObject({
      templateId: first.templateId,
      version: 2,
      previousTemplateVersionId: first.templateVersionId,
      active: true,
    });
    expect(mocks.calls.some((call) => call.text.includes("UPDATE omni_workspace_template_channels"))).toBe(true);
    expect(mocks.calls.some((call) => call.text.includes("UPDATE omni_workspace_template_versions"))).toBe(false);
    expect(mocks.events).toHaveBeenCalledTimes(2);
  });

  it("rejects a reused publication idempotency key with changed content", async () => {
    const { publishWorkspaceTemplate, WorkspaceTemplateConflictError } = await import("@/lib/workspace-templates/store");
    mocks.responses.push(
      [], [], [], [{ published_at: new Date("2026-09-07T10:00:00.000Z") }], [], [],
    );
    const first = await publishWorkspaceTemplate({
      authority: mutationAuthority("workspace.template.publish", "same-key"),
      definition,
    });
    const insert = mocks.calls.find((call) => call.text.includes("INSERT INTO omni_workspace_template_versions"));
    expect(insert).toBeDefined();
    const requestDigest = insert!.values[11];
    mocks.responses.push([], [{
      template_snapshot: first,
      active_template_version: 1,
      publish_request_sha256: requestDigest,
    }]);
    await expect(publishWorkspaceTemplate({
      authority: mutationAuthority("workspace.template.publish", "same-key"),
      definition: { ...definition, name: "Changed" },
    })).rejects.toBeInstanceOf(WorkspaceTemplateConflictError);
  });
});
