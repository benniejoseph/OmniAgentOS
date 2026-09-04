import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const state = { databaseEnabled: true };
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => state.databaseEnabled),
    readJsonFile: vi.fn(),
    rows,
    sql,
    state,
    statements,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  };
});

vi.mock("@/lib/storage/json", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/json")>();
  return {
    ...actual,
    readJsonFile: dbMocks.readJsonFile,
  };
});

import { builtInSkills } from "@/lib/skills/catalog";
import {
  getAgentSkill,
  getAgentSkillForRequest,
  listAgentSkills,
  listAgentSkillsForRequest,
} from "@/lib/skills/store";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "skill-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.state.databaseEnabled = true;
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getDatabaseTenantContext.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.readJsonFile.mockReset().mockResolvedValue({ skills: [], agents: [] });
  dbMocks.sql.mockClear();
});

describe("Postgres custom Skill request reads", () => {
  it("reads the complete owner pair in deterministic order and projects custom owners", async () => {
    dbMocks.rows.push(
      skillRow("canonical-skill", canonicalActorId, "canonical-skill"),
      skillRow("email-skill", actorId, "email-skill"),
    );

    const skills = await listAgentSkillsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });

    expect(skills.slice(0, builtInSkills.length)).toEqual(builtInSkills);
    expect(skills.slice(builtInSkills.length)).toEqual([
      expect.objectContaining({ id: "canonical-skill", actorId }),
      expect.objectContaining({ id: "email-skill", actorId }),
    ]);
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /FROM omni_custom_skills[\s\S]*WHERE tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*ORDER BY updated_at DESC, id ASC/,
    );
    expect(dbMocks.statements[0].text).not.toMatch(/\bLIMIT\b/);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
    ]);
  });

  it("fails closed on a duplicate slug anywhere across the readable actors", async () => {
    dbMocks.rows.push(
      skillRow("selected-skill", canonicalActorId, "selected"),
      skillRow("canonical-collision", canonicalActorId, "collision"),
      skillRow("email-collision", actorId, "collision"),
    );

    await expect(getAgentSkillForRequest("selected-skill", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toThrow(/slug is ambiguous/i);
    expect(dbMocks.statements[0].text).not.toMatch(/\bLIMIT\b/);
  });

  it("rejects rows outside the selected tenant and owner pair", async () => {
    dbMocks.rows.push({
      ...skillRow("wrong-owner", "third-owner@example.test", "wrong-owner"),
      tenant_id: "tenant-a",
    });
    await expect(listAgentSkillsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, false)).rejects.toThrow(/owner validation failed/i);

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      { ...skillRow("wrong-tenant", actorId, "wrong-tenant"), tenant_id: "tenant-b" },
    );
    await expect(listAgentSkillsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, false)).rejects.toThrow(/owner validation failed/i);
  });

  it("returns built-in details unchanged without reading custom storage", async () => {
    await expect(getAgentSkillForRequest(builtInSkills[0].id, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toBe(builtInSkills[0]);
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });

  it("resolves a globally unique custom detail and projects only its actor", async () => {
    dbMocks.rows.push(
      skillRow("canonical-detail", canonicalActorId, "canonical-detail"),
    );

    await expect(getAgentSkillForRequest("canonical-detail", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-detail",
      tenantId: "tenant-a",
      actorId,
      slug: "canonical-detail",
    }));
    expect(dbMocks.statements[0].text).not.toMatch(/\bLIMIT\b/);
  });

  it("uses an exact actor query for a missing or malformed binding", async () => {
    await listAgentSkillsForRequest({ tenantId: "tenant-a", actorId }, false);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
    ]);

    dbMocks.statements.splice(0);
    await listAgentSkillsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        legacyOwnerActorIds: Object.freeze(["another-owner@example.test"]),
      },
    }, false);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
    ]);
  });

  it("keeps exact helpers and file fallback outside request convergence", async () => {
    await listAgentSkills({ tenantId: "tenant-a", actorId }, false);
    expect(dbMocks.statements[0].text).not.toContain(" OR actor_id = ");
    expect(dbMocks.statements[0].params).toEqual(["tenant-a", actorId]);

    dbMocks.statements.splice(0);
    await getAgentSkill("missing-skill", { tenantId: "tenant-a", actorId });
    expect(dbMocks.statements[0].text).not.toContain(" OR actor_id = ");
    expect(dbMocks.statements[0].params).toEqual(["tenant-a", actorId]);

    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      skills: [
        fileSkill("canonical-file-skill", canonicalActorId),
        fileSkill("email-file-skill", actorId),
      ],
      agents: [],
    });
    await expect(listAgentSkillsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, false)).resolves.toEqual([
      expect.objectContaining({ id: "email-file-skill", actorId }),
    ]);
    await expect(getAgentSkillForRequest("canonical-file-skill", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toBeUndefined();
  });
});

function skillRow(id: string, ownerActorId: string, slug: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    slug,
    name: id,
    description: `Description for ${id}`,
    instructions: `Instructions for ${id}`,
    category: "personal",
    status: "active",
    version: 1,
    tool_ids: ["memory.search"],
    tags: ["daily"],
    knowledge_tags: ["context"],
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

function fileSkill(id: string, ownerActorId: string) {
  return {
    id,
    tenantId: "tenant-a",
    actorId: ownerActorId,
    slug: id,
    name: id,
    description: `Description for ${id}`,
    instructions: `Instructions for ${id}`,
    category: "personal" as const,
    status: "active" as const,
    version: 1,
    toolIds: ["memory.search"],
    tags: ["daily"],
    knowledgeTags: ["context"],
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
