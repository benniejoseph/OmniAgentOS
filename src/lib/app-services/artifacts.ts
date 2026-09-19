import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  completeGeneratedArtifactRender,
  createGeneratedArtifactVersion,
  failGeneratedArtifactRender,
  startGeneratedArtifactRender,
} from "@/lib/artifacts/store";
import {
  parsePresentationBlueprint,
  presentationBlueprintSchema,
  presentationSpecDigest,
  type PresentationBlueprint,
  type PresentationSlideKind,
} from "@/lib/artifacts/presentation-spec";
import { renderPresentation } from "@/lib/artifacts/presentation-renderer";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const PRESENTATION_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const presentationArtifactCreateServiceInputSchema = presentationBlueprintSchema;

export type PresentationArtifactCreateServiceInput = PresentationBlueprint;

export async function createPresentationArtifactService(
  caller: AppServiceCaller,
  input: PresentationArtifactCreateServiceInput,
) {
  const value = presentationArtifactCreateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.artifacts.presentations.create"),
  );
  const blueprint = parsePresentationBlueprint(value);
  const createScope = artifactExecutionScope(caller, {
    purpose: "artifact.create",
  });
  const renderScope = artifactExecutionScope(caller, {
    purpose: "artifact.render",
  });
  const mutationKey = artifactMutationKey(caller);
  let version = await createGeneratedArtifactVersion({
    tenantId: caller.context.tenantId,
    ownerActorId: caller.context.actorId,
    title: blueprint.title,
    kind: "presentation",
    spec: blueprint,
    mediaType: PRESENTATION_MIME_TYPE,
    projectId: createScope.projectId,
    missionId: createScope.missionId,
    mutation: {
      executionScope: createScope,
      idempotencyKey: mutationKey,
    },
  });

  if (version.renderStatus === "ready") {
    return completeReadyPresentation(authorized, version, blueprint);
  }
  if (version.renderStatus === "failed") {
    throw new PresentationArtifactRenderError(
      version.failureCode || "presentation_render_failed",
    );
  }

  try {
    if (version.renderStatus === "queued") {
      version = await startGeneratedArtifactRender({
        tenantId: caller.context.tenantId,
        ownerActorId: caller.context.actorId,
        artifactId: version.artifactId,
        artifactVersion: version.version,
        mutation: {
          executionScope: renderScope,
          idempotencyKey: mutationKey,
        },
      });
    }
    if (version.renderStatus === "ready") {
      return completeReadyPresentation(authorized, version, blueprint);
    }
    if (version.renderStatus === "failed") {
      throw new PresentationArtifactRenderError(
        version.failureCode || "presentation_render_failed",
      );
    }
    if (version.renderStatus !== "rendering") {
      throw new PresentationArtifactRenderError("presentation_render_state_invalid");
    }

    const rendered = await renderPresentation(blueprint);
    const ready = await completeGeneratedArtifactRender({
      tenantId: caller.context.tenantId,
      ownerActorId: caller.context.actorId,
      artifactId: version.artifactId,
      artifactVersion: version.version,
      bytes: rendered.bytes,
      mutation: {
        executionScope: renderScope,
        idempotencyKey: mutationKey,
      },
    });
    if (
      ready.renderStatus !== "ready" ||
      ready.contentSha256 !== rendered.sha256 ||
      ready.byteCount !== rendered.byteCount
    ) {
      throw new PresentationArtifactRenderError(
        "presentation_render_receipt_mismatch",
      );
    }
    return completeReadyPresentation(
      authorized,
      ready,
      blueprint,
      rendered.summary,
    );
  } catch (error) {
    if (version.renderStatus === "failed") throw error;
    const failureCode = boundedFailureCode(error);
    try {
      await failGeneratedArtifactRender({
        tenantId: caller.context.tenantId,
        ownerActorId: caller.context.actorId,
        artifactId: version.artifactId,
        artifactVersion: version.version,
        failureCode,
        mutation: {
          executionScope: renderScope,
          idempotencyKey: mutationKey,
        },
      });
    } catch (failureReceiptError) {
      throw new AggregateError(
        [error, failureReceiptError],
        "Presentation rendering failed and its failure receipt could not be recorded.",
      );
    }
    throw error;
  }
}

export class PresentationArtifactRenderError extends Error {
  constructor(public readonly code: string) {
    super(`Presentation artifact generation failed (${code}).`);
    this.name = "PresentationArtifactRenderError";
  }
}

function completeReadyPresentation(
  authorized: Parameters<typeof completeAppServiceCall>[0],
  version: Awaited<ReturnType<typeof completeGeneratedArtifactRender>>,
  blueprint: PresentationBlueprint,
  renderedSummary?: Readonly<{
    title: string;
    subtitle?: string;
    theme: PresentationBlueprint["theme"];
    slideCount: number;
    slideKinds: Readonly<Record<PresentationSlideKind, number>>;
    specDigest: string;
  }>,
) {
  if (
    version.renderStatus !== "ready" ||
    !version.contentSha256 ||
    !version.byteCount
  ) {
    throw new PresentationArtifactRenderError("presentation_render_not_ready");
  }
  const slideSummary = renderedSummary || summarizeBlueprint(blueprint);
  return completeAppServiceCall(authorized, {
    artifact: Object.freeze({
      artifactId: version.artifactId,
      versionId: version.id,
      version: version.version,
      filename: presentationFilename(version.title),
      kind: "presentation" as const,
      mediaType: version.mediaType,
      byteCount: version.byteCount,
      contentSha256: version.contentSha256,
      status: version.renderStatus,
      slideSummary,
      contentUrl: `/api/artifacts/${encodeURIComponent(version.artifactId)}/content?version=${version.version}`,
    }),
  }, { resourceCount: 1 });
}

function artifactExecutionScope(
  caller: AppServiceCaller,
  input: {
    purpose: "artifact.create" | "artifact.render";
  },
) {
  const source = caller.executionScope;
  if (
    !source ||
    source.tenantId !== caller.context.tenantId ||
    source.initiatingActorId !== caller.context.actorId ||
    !source.executingPrincipalId
  ) {
    throw new Error(
      "Presentation creation requires an exact tenant, actor, and executing-principal scope.",
    );
  }
  return deriveExecutionScope(source, {
    projectId: source.projectId,
    missionId: source.missionId,
    purpose: input.purpose,
  });
}

function artifactMutationKey(caller: AppServiceCaller) {
  return `presentation_${canonicalJsonSha256({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    idempotencyKey: caller.idempotencyKey,
  }).slice(0, 48)}`;
}

function boundedFailureCode(error: unknown) {
  if (
    error instanceof PresentationArtifactRenderError &&
    /^[a-z0-9_]{1,80}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "presentation_render_failed";
}

function summarizeBlueprint(blueprint: PresentationBlueprint) {
  const slideKinds: Record<PresentationSlideKind, number> = {
    title: 0,
    section: 0,
    content: 0,
    two_column: 0,
    quote: 0,
    metrics: 0,
    closing: 0,
  };
  for (const slide of blueprint.slides) slideKinds[slide.kind] += 1;
  return Object.freeze({
    title: blueprint.title,
    ...(blueprint.subtitle ? { subtitle: blueprint.subtitle } : {}),
    theme: blueprint.theme,
    slideCount: blueprint.slides.length,
    slideKinds: Object.freeze(slideKinds),
    specDigest: presentationSpecDigest(blueprint),
  });
}

function presentationFilename(title: string) {
  const stem = title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100) || "Asael-presentation";
  return `${stem}.pptx`;
}
