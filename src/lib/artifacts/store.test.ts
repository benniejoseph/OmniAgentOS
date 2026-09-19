import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generatedArtifactSpecSha256,
  parseGeneratedArtifactSpec,
} from "@/lib/artifacts/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  stageAssetObject: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/storage/object-plane", () => ({
  stageAssetObject: mocks.stageAssetObject,
}));

import {
  completeGeneratedArtifactRender,
  createGeneratedArtifactVersion,
  readGeneratedArtifactContent,
  startGeneratedArtifactRender,
} from "@/lib/artifacts/store";

const tenantId = "tenant-artifact-a";
const ownerActorId = "actor:11111111-1111-4111-a111-111111111111";
const projectId = "project:artifact-a";
const spec = {
  schemaVersion: 1,
  sections: [
    { kind: "heading", text: "Client transformation proposal" },
    { kind: "paragraph", text: "A governed AI service layer." },
  ],
};

function mutation(
  purpose: "artifact.create" | "artifact.render",
  idempotencyKey: string,
) {
  return {
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId,
      initiatingActorId: ownerActorId,
      executingPrincipalType: "user",
      executingPrincipalId: ownerActorId,
      projectId,
      correlationId: `correlation:${idempotencyKey}`,
      capabilityGrantIds: ["first_party.generated_artifacts"],
      purpose,
    }),
  } as const;
}

type Row = Record<string, unknown>;

function createArtifactSqlHarness() {
  let head: Row | undefined;
  let version: Row | undefined;
  const mutations = new Map<string, Row>();
  let clock = Date.parse("2026-09-19T08:00:00.000Z");
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ").replace(/\s+/g, " ");
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("SELECT clock_timestamp() AS now")) {
        clock += 1_000;
        return [{ now: new Date(clock).toISOString() }];
      }
      if (query.includes("FROM omni_generated_artifact_mutations")) {
        const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
        const row = mutations.get(key);
        return row ? [row] : [];
      }
      if (
        query.includes("FROM omni_generated_artifacts") &&
        query.includes("FOR UPDATE")
      ) {
        return head ? [head] : [];
      }
      if (query.includes("INSERT INTO omni_generated_artifacts")) {
        head = {
          id: values[0],
          tenant_id: values[1],
          owner_actor_id: values[2],
          kind: values[3],
          title: values[4],
          current_version: 1,
          current_version_id: values[5],
          project_id: values[6],
          mission_id: values[7],
          work_item_id: values[8],
          created_at: values[9],
          updated_at: values[10],
        };
        return [];
      }
      if (query.includes("INSERT INTO omni_generated_artifact_versions")) {
        version = {
          id: values[0],
          artifact_id: values[1],
          tenant_id: values[2],
          owner_actor_id: values[3],
          artifact_version: values[4],
          kind: values[5],
          title: values[6],
          render_status: "queued",
          spec_snapshot: values[7],
          spec_sha256: values[8],
          media_type: values[9],
          content_sha256: null,
          byte_count: null,
          content_bytes: null,
          lineage_refs: values[10],
          evidence_refs: values[11],
          project_id: values[12],
          mission_id: values[13],
          work_item_id: values[14],
          google_resource_ref: null,
          failure_code: null,
          creation_idempotency_key_sha256: values[15],
          creation_request_sha256: values[16],
          execution_scope: values[17],
          queued_at: values[18],
          rendering_started_at: null,
          ready_at: null,
          failed_at: null,
          created_at: values[19],
          updated_at: values[20],
        };
        return [];
      }
      if (query.includes("INSERT INTO omni_generated_artifact_mutations")) {
        const row = {
          id: values[0],
          tenant_id: values[1],
          owner_actor_id: values[2],
          artifact_id: values[3],
          artifact_version_id: values[4],
          operation: values[5],
          idempotency_key_sha256: values[6],
          request_sha256: values[7],
          result_status: values[8],
          event_id: values[9],
          execution_scope: values[10],
          created_at: values[11],
        };
        mutations.set(
          `${values[1]}:${values[2]}:${values[5]}:${values[6]}`,
          row,
        );
        return [];
      }
      if (
        query.includes("FROM omni_generated_artifact_versions") &&
        (query.includes("FOR UPDATE") || query.includes("WHERE id ="))
      ) {
        return version ? [version] : [];
      }
      if (
        query.includes("FROM omni_generated_artifact_versions") &&
        query.includes("render_status = 'ready'")
      ) {
        return version?.render_status === "ready" ? [version] : [];
      }
      if (query.includes("SET render_status = 'rendering'")) {
        if (!version || version.render_status !== "queued") return [];
        version = {
          ...version,
          render_status: "rendering",
          rendering_started_at: values[0],
          updated_at: values[1],
        };
        return [version];
      }
      if (query.includes("SET render_status = 'ready'")) {
        if (!version || version.render_status !== "rendering") return [];
        version = {
          ...version,
          render_status: "ready",
          content_sha256: values[0],
          byte_count: values[1],
          content_bytes: values[2],
          google_resource_ref: values[3],
          ready_at: values[4],
          updated_at: values[5],
        };
        return [version];
      }
      if (query.includes("SET render_status = 'failed'")) {
        if (!version || !["queued", "rendering"].includes(String(version.render_status))) {
          return [];
        }
        version = {
          ...version,
          render_status: "failed",
          failure_code: values[0],
          failed_at: values[1],
          updated_at: values[2],
        };
        return [version];
      }
      throw new Error(`Unexpected artifact query: ${query}`);
    }),
    {
      transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback(sql)
      ),
    },
  );
  return {
    sql,
    getVersion: () => version,
    mutateContent: (bytes: Uint8Array) => {
      if (version) version = { ...version, content_bytes: bytes };
    },
  };
}

beforeEach(() => {
  mocks.appendScopedDomainEvent.mockReset().mockResolvedValue({});
  mocks.stageAssetObject.mockReset().mockResolvedValue({
    id: "asset-object-a",
    status: "pending",
  });
});

describe("generated artifact contracts", () => {
  it("hashes structured specs canonically and rejects non-JSON input", () => {
    expect(generatedArtifactSpecSha256({ b: 2, a: 1 })).toBe(
      generatedArtifactSpecSha256({ a: 1, b: 2 }),
    );
    expect(() => parseGeneratedArtifactSpec(["not", "an", "object"]))
      .toThrow("must be a JSON object");
    expect(() => parseGeneratedArtifactSpec({ value: Number.NaN }))
      .toThrow("non-finite");
  });
});

describe("generated artifact persistence", () => {
  it("creates an actor-scoped immutable version and converges an exact replay", async () => {
    const harness = createArtifactSqlHarness();
    const input = {
      tenantId,
      ownerActorId,
      title: "AI service transformation",
      kind: "presentation" as const,
      spec,
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      projectId,
      lineageRefs: ["thread:proposal-a"],
      evidenceRefs: ["memory:client-context-a"],
      mutation: mutation("artifact.create", "artifact-create-a"),
    };

    const created = await createGeneratedArtifactVersion(input, {
      sql: harness.sql as never,
    });
    const replayed = await createGeneratedArtifactVersion(input, {
      sql: harness.sql as never,
    });

    expect(created).toMatchObject({
      ownerActorId,
      kind: "presentation",
      version: 1,
      renderStatus: "queued",
      projectId,
      contentSha256: null,
    });
    expect(replayed).toEqual(created);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledOnce();
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "generated_artifact.version.queued",
        executionScope: input.mutation.executionScope,
      }),
      { sql: harness.sql },
    );
  });

  it("renders, stages a private generated object, and verifies canonical bytes", async () => {
    const harness = createArtifactSqlHarness();
    const created = await createGeneratedArtifactVersion({
      tenantId,
      ownerActorId,
      title: "Client proposal",
      kind: "document",
      spec,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      projectId,
      mutation: mutation("artifact.create", "artifact-create-b"),
    }, { sql: harness.sql as never });
    await startGeneratedArtifactRender({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: created.version,
      mutation: mutation("artifact.render", "artifact-start-b"),
    }, { sql: harness.sql as never });
    const bytes = new Uint8Array(Buffer.from("verified generated document"));
    const ready = await completeGeneratedArtifactRender({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: created.version,
      bytes,
      googleResourceRef: {
        provider: "google_workspace",
        resourceType: "document",
        resourceId: "google-document-a",
        revisionId: null,
      },
      mutation: mutation("artifact.render", "artifact-ready-b"),
    }, { sql: harness.sql as never });
    const content = await readGeneratedArtifactContent({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: created.version,
    }, { sql: harness.sql as never });

    expect(ready).toMatchObject({
      renderStatus: "ready",
      byteCount: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      googleResourceRef: { resourceId: "google-document-a" },
    });
    expect(content.bytes).toEqual(bytes);
    expect(mocks.stageAssetObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "generated_artifact",
        sourceId: created.artifactId,
        objectVersion: 1,
        projectId,
        allowedPurposeIds: [
          "artifact.download",
          "artifact.export",
          "artifact.preview",
        ],
      }),
      { sql: harness.sql },
    );
  });

  it("fails closed when stored rendered bytes do not match their digest", async () => {
    const harness = createArtifactSqlHarness();
    const created = await createGeneratedArtifactVersion({
      tenantId,
      ownerActorId,
      title: "Integrity test",
      kind: "pdf",
      spec,
      mediaType: "application/pdf",
      projectId,
      mutation: mutation("artifact.create", "artifact-create-c"),
    }, { sql: harness.sql as never });
    await startGeneratedArtifactRender({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: 1,
      mutation: mutation("artifact.render", "artifact-start-c"),
    }, { sql: harness.sql as never });
    await completeGeneratedArtifactRender({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: 1,
      bytes: new Uint8Array(Buffer.from("original")),
      mutation: mutation("artifact.render", "artifact-ready-c"),
    }, { sql: harness.sql as never });
    harness.mutateContent(new Uint8Array(Buffer.from("tampered")));

    await expect(readGeneratedArtifactContent({
      tenantId,
      ownerActorId,
      artifactId: created.artifactId,
      artifactVersion: 1,
    }, { sql: harness.sql as never })).rejects.toMatchObject({
      code: "invalid_contract",
    });
  });

  it("rejects a mutation whose actor is not the scoped owner", async () => {
    const harness = createArtifactSqlHarness();
    await expect(createGeneratedArtifactVersion({
      tenantId,
      ownerActorId,
      title: "Wrong actor",
      kind: "document",
      spec,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      mutation: {
        ...mutation("artifact.create", "artifact-create-d"),
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: "actor:22222222-2222-4222-a222-222222222222",
          executingPrincipalType: "user",
          executingPrincipalId: "actor:22222222-2222-4222-a222-222222222222",
          correlationId: "wrong-actor",
          purpose: "artifact.create",
        }),
      },
    }, { sql: harness.sql as never })).rejects.toMatchObject({
      code: "invalid_contract",
    });
  });
});
