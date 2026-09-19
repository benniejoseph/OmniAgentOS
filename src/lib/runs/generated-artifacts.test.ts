import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listStreamEvents: vi.fn(),
  getToolExecutionsByIds: vi.fn(),
  getGeneratedArtifactVersion: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
}));

vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecutionsByIds: mocks.getToolExecutionsByIds,
}));

vi.mock("@/lib/artifacts/store", () => ({
  getGeneratedArtifactVersion: mocks.getGeneratedArtifactVersion,
}));

import { listRunGeneratedArtifacts } from "@/lib/runs/generated-artifacts";

const tenantId = "tenant-artifact-projection";
const actorId = "actor-artifact-owner";
const artifactId = `generated_artifact_${"a".repeat(48)}`;
const mediaType =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("run generated-artifact projection", () => {
  beforeEach(() => {
    mocks.listStreamEvents.mockReset();
    mocks.getToolExecutionsByIds.mockReset();
    mocks.getGeneratedArtifactVersion.mockReset();
  });

  it("projects only canonical ready metadata and builds the private content URL", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent("execution-1", 12),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([{
      id: "execution-1",
      tenantId,
      actorId,
      toolId: "app.artifacts.presentations.create",
      toolName: "Create editable presentation",
      riskLevel: 1,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input: { title: "private prompt" },
      output: {
        artifact: {
          artifactId,
          version: 2,
          title: "spoofed title",
          contentUrl: "https://untrusted.example/private.pptx",
          bytes: "private-presentation-bytes",
        },
      },
      createdAt: "2026-09-19T03:00:00.000Z",
      completedAt: "2026-09-19T03:01:00.000Z",
    }]);
    mocks.getGeneratedArtifactVersion.mockResolvedValue({
      artifactId,
      version: 2,
      kind: "presentation",
      title: "Client / Service Cloud Pitch",
      renderStatus: "ready",
      mediaType,
      byteCount: 42_048,
      contentSha256: "b".repeat(64),
      readyAt: "2026-09-19T03:00:59.000Z",
      spec: {
        title: "Client Service Cloud Pitch",
        theme: "aurora",
        slides: [
          { kind: "title", title: "A better service experience" },
          { kind: "closing", title: "Next steps" },
        ],
      },
    });

    const artifacts = await listRunGeneratedArtifacts("run-1", {
      tenantId,
      actorId,
    });

    expect(mocks.getToolExecutionsByIds).toHaveBeenCalledWith(
      ["execution-1"],
      { tenantId },
    );
    expect(mocks.getGeneratedArtifactVersion).toHaveBeenCalledWith({
      tenantId,
      ownerActorId: actorId,
      artifactId,
      artifactVersion: 2,
    });
    expect(artifacts).toEqual([{
      executionId: "execution-1",
      sequence: 12,
      artifactId,
      version: 2,
      kind: "presentation",
      title: "Client / Service Cloud Pitch",
      filename: "Client Service Cloud Pitch.pptx",
      mediaType,
      byteCount: 42_048,
      status: "ready",
      contentUrl: `/api/artifacts/${artifactId}/content?version=2`,
      createdAt: "2026-09-19T03:01:00.000Z",
      slideCount: 2,
      theme: "aurora",
    }]);
    expect(JSON.stringify(artifacts)).not.toContain("untrusted.example");
    expect(JSON.stringify(artifacts)).not.toContain("private-presentation-bytes");
    expect(JSON.stringify(artifacts)).not.toContain("private prompt");
  });

  it("rejects sibling executions before resolving canonical content", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent("execution-sibling", 4),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([{
      id: "execution-sibling",
      tenantId,
      actorId: "actor-sibling",
      toolId: "app.artifacts.presentations.create",
      status: "executed",
      dryRun: false,
      output: { artifact: { artifactId, version: 1 } },
    }]);

    await expect(listRunGeneratedArtifacts("run-2", {
      tenantId,
      actorId,
    })).resolves.toEqual([]);
    expect(mocks.getGeneratedArtifactVersion).not.toHaveBeenCalled();
  });

  it("rejects non-ready, wrong-kind, and malformed output references", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      runToolEvent("malformed", 1),
      runToolEvent("not-ready", 2),
      runToolEvent("wrong-kind", 3),
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([
      execution("malformed", { artifactId: "../../etc/passwd", version: 1 }),
      execution("not-ready", { artifactId, version: 1 }),
      execution("wrong-kind", { artifactId, version: 2 }),
    ]);
    mocks.getGeneratedArtifactVersion
      .mockResolvedValueOnce({
        artifactId,
        version: 1,
        kind: "presentation",
        renderStatus: "rendering",
        mediaType,
      })
      .mockResolvedValueOnce({
        artifactId,
        version: 2,
        kind: "document",
        renderStatus: "ready",
        mediaType,
        byteCount: 100,
        contentSha256: "c".repeat(64),
      });

    await expect(listRunGeneratedArtifacts("run-3", {
      tenantId,
      actorId,
    })).resolves.toEqual([]);
  });
});

function runToolEvent(executionId: string, seq: number) {
  return {
    id: `event-${seq}`,
    seq,
    streamId: "run:test",
    type: "run.tool",
    tenantId,
    actorId,
    payload: {
      executionId,
      toolId: "app.artifacts.presentations.create",
      status: "executed",
    },
    at: `2026-09-19T03:00:0${seq % 10}.000Z`,
  };
}

function execution(
  id: string,
  artifact: { artifactId: string; version: number },
) {
  return {
    id,
    tenantId,
    actorId,
    toolId: "app.artifacts.presentations.create",
    status: "executed",
    dryRun: false,
    output: { artifact },
  };
}
