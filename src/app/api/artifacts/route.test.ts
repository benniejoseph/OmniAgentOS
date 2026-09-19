import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listGeneratedArtifacts: vi.fn(),
  getGeneratedArtifact: vi.fn(),
  getGeneratedArtifactVersion: vi.fn(),
  readGeneratedArtifactContent: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/artifacts/store", () => {
  class GeneratedArtifactError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
      this.name = "GeneratedArtifactError";
    }
  }
  return {
    GeneratedArtifactError,
    listGeneratedArtifacts: routeMocks.listGeneratedArtifacts,
    getGeneratedArtifact: routeMocks.getGeneratedArtifact,
    getGeneratedArtifactVersion: routeMocks.getGeneratedArtifactVersion,
    readGeneratedArtifactContent: routeMocks.readGeneratedArtifactContent,
  };
});

import { GET as listArtifacts } from "@/app/api/artifacts/route";
import { GET as showArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as downloadArtifact } from "@/app/api/artifacts/[id]/content/route";

const tenantId = "tenant-generated-artifacts";
const actorId = "actor-generated-artifacts";
const artifactId = `generated_artifact_${"d".repeat(48)}`;
const mediaType =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("generated artifact HTTP routes", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId,
      actorId,
      role: "admin",
      source: "session",
    });
    routeMocks.listGeneratedArtifacts.mockReset().mockResolvedValue([head()]);
    routeMocks.getGeneratedArtifact.mockReset().mockResolvedValue(head());
    routeMocks.getGeneratedArtifactVersion.mockReset().mockResolvedValue(version());
    routeMocks.readGeneratedArtifactContent.mockReset().mockResolvedValue({
      version: version(),
      bytes: new Uint8Array([80, 75, 3, 4]),
    });
  });

  it("lists only actor-scoped safe metadata", async () => {
    const response = await listArtifacts(new Request(
      "http://asael.test/api/artifacts?kind=presentation&limit=12",
    ));

    expect(response.status).toBe(200);
    expect(routeMocks.listGeneratedArtifacts).toHaveBeenCalledWith({
      tenantId,
      ownerActorId: actorId,
      kind: "presentation",
      limit: 12,
    });
    expect(routeMocks.getGeneratedArtifactVersion).toHaveBeenCalledWith({
      tenantId,
      ownerActorId: actorId,
      artifactId,
      artifactVersion: 3,
    });
    const body = await response.json();
    expect(body).toEqual({
      artifacts: [expect.objectContaining({
        id: artifactId,
        kind: "presentation",
        title: "Client Service Cloud Pitch",
        filename: "Client Service Cloud Pitch.pptx",
        current: expect.objectContaining({
          status: "ready",
          contentUrl: `/api/artifacts/${artifactId}/content?version=3`,
        }),
      })],
    });
    expect(JSON.stringify(body)).not.toContain("private slide spec");
    expect(JSON.stringify(body)).not.toContain("executionScope");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns safe metadata for one exact artifact owner", async () => {
    const response = await showArtifact(
      new Request(`http://asael.test/api/artifacts/${artifactId}`),
      { params: Promise.resolve({ id: artifactId }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "generated_artifact",
      resourceId: artifactId,
    }));
    expect(routeMocks.getGeneratedArtifact).toHaveBeenCalledWith({
      tenantId,
      ownerActorId: actorId,
      artifactId,
    });
    const body = await response.json();
    expect(body.artifact).toMatchObject({
      id: artifactId,
      currentVersion: 3,
      current: { version: 3, status: "ready" },
    });
    expect(body.artifact).not.toHaveProperty("spec");
    expect(body.artifact).not.toHaveProperty("executionScope");
  });

  it("serves verified bytes as a private attachment with a safe filename", async () => {
    routeMocks.readGeneratedArtifactContent.mockResolvedValue({
      version: version({ title: "Client / Plan \"Private\"" }),
      bytes: new Uint8Array([80, 75, 3, 4]),
    });
    const response = await downloadArtifact(
      new Request(
        `http://asael.test/api/artifacts/${artifactId}/content?version=3`,
      ),
      { params: Promise.resolve({ id: artifactId }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.readGeneratedArtifactContent).toHaveBeenCalledWith({
      tenantId,
      ownerActorId: actorId,
      artifactId,
      artifactVersion: 3,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4]),
    );
    expect(response.headers.get("content-type")).toBe(mediaType);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/u);
    expect(response.headers.get("content-disposition")).not.toContain("Client / Plan");
  });

  it("rejects malformed list and version queries before touching storage", async () => {
    const listResponse = await listArtifacts(new Request(
      "http://asael.test/api/artifacts?limit=1000",
    ));
    const contentResponse = await downloadArtifact(
      new Request(`http://asael.test/api/artifacts/${artifactId}/content?version=3.1`),
      { params: Promise.resolve({ id: artifactId }) },
    );

    expect(listResponse.status).toBe(400);
    expect(contentResponse.status).toBe(400);
    expect(routeMocks.listGeneratedArtifacts).not.toHaveBeenCalled();
    expect(routeMocks.readGeneratedArtifactContent).not.toHaveBeenCalled();
  });
});

function head(overrides: Record<string, unknown> = {}) {
  return {
    id: artifactId,
    tenantId,
    ownerActorId: actorId,
    kind: "presentation",
    title: "Client Service Cloud Pitch",
    currentVersion: 3,
    currentVersionId: `${artifactId}:v3`,
    projectId: null,
    missionId: null,
    workItemId: null,
    createdAt: "2026-09-19T02:00:00.000Z",
    updatedAt: "2026-09-19T02:01:00.000Z",
    ...overrides,
  };
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: `${artifactId}:v3`,
    artifactId,
    tenantId,
    ownerActorId: actorId,
    version: 3,
    kind: "presentation",
    title: "Client Service Cloud Pitch",
    renderStatus: "ready",
    spec: { body: "private slide spec" },
    mediaType,
    contentSha256: "f".repeat(64),
    byteCount: 4,
    executionScope: { private: true },
    queuedAt: "2026-09-19T02:00:00.000Z",
    readyAt: "2026-09-19T02:01:00.000Z",
    failedAt: null,
    createdAt: "2026-09-19T02:00:00.000Z",
    updatedAt: "2026-09-19T02:01:00.000Z",
    ...overrides,
  };
}
