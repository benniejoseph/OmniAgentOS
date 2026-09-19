import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queue: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  render: vi.fn(),
}));

vi.mock("@/lib/artifacts/store", () => ({
  createGeneratedArtifactVersion: mocks.queue,
  startGeneratedArtifactRender: mocks.start,
  completeGeneratedArtifactRender: mocks.complete,
  failGeneratedArtifactRender: mocks.fail,
}));

vi.mock("@/lib/artifacts/presentation-renderer", () => ({
  renderPresentation: mocks.render,
}));

import {
  createPresentationArtifactService,
  presentationArtifactCreateServiceInputSchema,
} from "@/lib/app-services/artifacts";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

const artifactId = `generated_artifact_${"a".repeat(48)}`;
const blueprint = {
  title: "AIForce for Service Cloud",
  subtitle: "A client pitch created in Asael",
  theme: "dark" as const,
  slides: [
    {
      kind: "title" as const,
      title: "AIForce for Service Cloud",
      subtitle: "From case volume to governed service intelligence",
    },
    {
      kind: "content" as const,
      title: "A practical first step",
      bullets: ["Select one high-volume journey", "Measure the baseline", "Run a bounded pilot"],
      speakerNotes: "Agree the pilot owner before closing.",
    },
    {
      kind: "closing" as const,
      title: "Design the pilot",
      callToAction: "Choose the service journey",
    },
  ],
};

function version(renderStatus: "queued" | "rendering" | "ready" | "failed") {
  return {
    id: `${artifactId}:v1`,
    artifactId,
    version: 1,
    title: blueprint.title,
    renderStatus,
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    contentSha256: renderStatus === "ready" ? "b".repeat(64) : null,
    byteCount: renderStatus === "ready" ? 3 : null,
    failureCode: renderStatus === "failed" ? "presentation_render_failed" : null,
  };
}

function caller(input: { projectId?: string; withScope?: boolean } = {}) {
  const context = {
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "operator" as const,
    source: "service" as const,
  };
  const executionScope = input.withScope === false
    ? undefined
    : createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      projectId: input.projectId,
      correlationId: "run-artifact-a",
      purpose: "agent.tool.execute",
    });
  return createAppServiceCaller({
    context,
    executionScope,
    idempotencyKey: "command-artifact-a",
  });
}

describe("presentation artifact application service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queue.mockResolvedValue(version("queued"));
    mocks.start.mockResolvedValue(version("rendering"));
    mocks.render.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "b".repeat(64),
      byteCount: 3,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: "pptx",
      summary: {
        title: blueprint.title,
        subtitle: blueprint.subtitle,
        theme: blueprint.theme,
        slideCount: 3,
        slideKinds: {
          title: 1, section: 0, content: 1, two_column: 0,
          quote: 0, metrics: 0, closing: 1,
        },
        specDigest: "c".repeat(64),
      },
    });
    mocks.complete.mockResolvedValue(version("ready"));
    mocks.fail.mockResolvedValue(version("failed"));
  });

  it("registers the governed creator as low-risk, approval-free, and explicitly non-reversible", () => {
    const tool = FIRST_PARTY_APP_TOOLS.find(
      (candidate) => candidate.id === "app.artifacts.presentations.create",
    );
    expect(tool).toMatchObject({
      category: "app",
      operationClass: "mutation",
      riskLevel: 1,
      approvalRequired: false,
      reversible: false,
    });
    expect(getAppServiceOperationContract(
      "app.artifacts.presentations.create",
    )).toMatchObject({
      action: "run.agent",
      resourceType: "generated_artifact",
      eventContract: "generated-artifact-events.v1",
    });
  });

  it("creates, renders, and returns only a safe actor-scoped artifact projection", async () => {
    const result = await createPresentationArtifactService(
      caller({ projectId: "project-a" }),
      blueprint,
    );

    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      title: blueprint.title,
      kind: "presentation",
      spec: blueprint,
      projectId: "project-a",
      missionId: null,
      mutation: {
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          executingPrincipalId: "atlas",
          projectId: "project-a",
          missionId: null,
          purpose: "artifact.create",
        }),
        idempotencyKey: expect.stringMatching(/^presentation_[a-f0-9]{48}$/u),
      },
    }));
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      artifactId,
      artifactVersion: 1,
      mutation: expect.objectContaining({
        executionScope: expect.objectContaining({
          projectId: "project-a",
          missionId: null,
          purpose: "artifact.render",
        }),
      }),
    }));
    expect(mocks.render).toHaveBeenCalledWith(blueprint);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      artifactId,
      artifactVersion: 1,
      bytes: new Uint8Array([1, 2, 3]),
    }));
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(result.data.artifact).toEqual(expect.objectContaining({
      artifactId,
      versionId: `${artifactId}:v1`,
      version: 1,
      filename: "AIForce-for-Service-Cloud.pptx",
      kind: "presentation",
      status: "ready",
      byteCount: 3,
      contentSha256: "b".repeat(64),
      contentUrl: `/api/artifacts/${artifactId}/content?version=1`,
      slideSummary: expect.objectContaining({ slideCount: 3 }),
    }));
    expect(result.data.artifact).not.toHaveProperty("bytes");
    expect(result.data.artifact).not.toHaveProperty("spec");
    expect(result.receipt.operation).toBe("app.artifacts.presentations.create");
  });

  it("records a bounded failed transition before rethrowing a renderer failure", async () => {
    mocks.render.mockRejectedValue(new Error("renderer internals must not become a failure code"));

    await expect(createPresentationArtifactService(caller(), blueprint))
      .rejects.toThrow("renderer internals must not become a failure code");

    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      artifactId,
      artifactVersion: 1,
      failureCode: "presentation_render_failed",
      mutation: expect.objectContaining({
        executionScope: expect.objectContaining({ purpose: "artifact.render" }),
      }),
    }));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("returns an idempotently ready version without rendering or exposing its spec", async () => {
    mocks.queue.mockResolvedValue(version("ready"));

    const result = await createPresentationArtifactService(caller(), blueprint);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(result.data.artifact).toMatchObject({
      artifactId,
      status: "ready",
      slideSummary: { slideCount: 3, theme: "dark" },
    });
  });

  it("requires mutation scope and rejects model-supplied association metadata", async () => {
    await expect(createPresentationArtifactService(
      caller({ withScope: false }),
      blueprint,
    )).rejects.toThrow("requires an exact execution scope");

    await expect(createPresentationArtifactService(
      caller({ projectId: "project-authorized" }),
      { ...blueprint, projectId: "project-other" } as never,
    )).rejects.toThrow();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("keeps service validation aligned with the strict bounded blueprint", () => {
    expect(presentationArtifactCreateServiceInputSchema.safeParse({
      ...blueprint,
      unsupportedRendererCode: "run me",
    }).success).toBe(false);
    expect(presentationArtifactCreateServiceInputSchema.safeParse({
      ...blueprint,
      evidenceRefs: ["knowledge:unverified"],
    }).success).toBe(false);
    expect(presentationArtifactCreateServiceInputSchema.safeParse({
      ...blueprint,
      slides: [blueprint.slides[0]],
    }).success).toBe(false);
  });
});
