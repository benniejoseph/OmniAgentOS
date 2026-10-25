import "server-only";
import { createHash } from "node:crypto";
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_VIDEO_MODEL,
  hasGeminiKey,
} from "@/lib/config";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { resolveSpecializedRuntime } from "@/lib/settings/specialized-runtime";
import {
  getProviderCredentials,
  listProviderConnections,
} from "@/lib/settings/store";
import { recordAiUsageSafely } from "@/lib/usage/ledger";
import {
  STUDIO_CAPABILITIES,
  getStudioCapability,
  renderStudioProviderPrompt,
  validateStudioProviderInputs,
  type StudioCapability,
} from "./capabilities";
import { studioCanonicalJson } from "./contracts";
import demoFixtures from "./fixtures/demo.json";
import {
  StudioProviderError,
  type StudioMaterializedOutput,
  type StudioProviderContext,
  type StudioProviderDiagnostic,
  type StudioProviderHandle,
  type StudioProviderOutputDescriptor,
  type StudioProviderRequest,
  type StudioProviderResult,
  type StudioProviderRoute,
} from "./provider-types";

const GOOGLE_INTERACTIONS =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const STUDIO_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 29 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
const OUTPUT_TOKEN_LIMIT = { image: 8_192, video: 65_536 } as const;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function ownerKey(ctx: StudioProviderContext) {
  if (!ctx.tenantId?.trim() || !ctx.actorId?.trim())
    throw new StudioProviderError(
      "missing_owner",
      "A signed-in workspace owner is required.",
      "rejected",
    );
  return createHash("sha256")
    .update(studioCanonicalJson([ctx.tenantId, ctx.actorId]))
    .digest("hex");
}
function requiredCapability(id: string) {
  const cap = getStudioCapability(id);
  if (!cap)
    throw new StudioProviderError(
      "unsupported_capability",
      "Choose a supported studio operation.",
      "rejected",
    );
  return cap;
}

export async function resolveStudioProviderRoute(
  capabilityId: string,
  ctx: StudioProviderContext,
): Promise<StudioProviderRoute> {
  const cap = requiredCapability(capabilityId);
  const owner = ownerKey(ctx);
  if (cap.demo)
    return {
      provider: "demo",
      model: cap.model,
      ownerKey: owner,
      credentialSource: "demo",
    };
  const runtime = await resolveSpecializedRuntime({
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    scope: cap.mediaKind === "image" ? "image_generation" : "video_generation",
    requiredCapability: cap.mediaKind,
    deploymentProvider: "google",
    deploymentModel:
      cap.mediaKind === "image" ? GEMINI_IMAGE_MODEL : GEMINI_VIDEO_MODEL,
    deploymentConfigured: hasGeminiKey(),
  });
  if (!runtime.configured)
    throw new StudioProviderError(
      "provider_unavailable",
      runtime.warning ||
        "Connect Google in Settings and assign an image/video model, or use a free Demo operation.",
      "rejected",
    );
  if (runtime.provider !== "google" || runtime.model !== cap.model)
    throw new StudioProviderError(
      "unsupported_route",
      `This operation requires ${cap.model}. The current Settings route uses ${runtime.provider}/${runtime.model}. Change the route or choose Demo.`,
      "rejected",
    );
  const route: StudioProviderRoute = {
    provider: "google",
    model: cap.model,
    ownerKey: owner,
    credentialSource:
      runtime.source === "tenant_assignment"
        ? "tenant_vault"
        : "deployment_environment",
    ...runtime.usageReceipt,
  };
  if (route.credentialSource === "tenant_vault") {
    const connections = await listProviderConnections({
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      includeDeploymentFallback: false,
    });
    const connection = connections.find(
      (c) =>
        c.provider === "google" &&
        c.source === "tenant_vault" &&
        c.status === "connected" &&
        c.enabled,
    );
    if (!connection)
      throw new StudioProviderError(
        "provider_unavailable",
        "Reconnect the Google provider in Settings.",
        "rejected",
      );
    route.connectionId = connection.id;
    route.credentialVersion = connection.credentialVersion;
  }
  return route;
}

export async function resolveStudioCapabilities(
  ctx: StudioProviderContext,
): Promise<StudioCapability[]> {
  ownerKey(ctx);
  // One resolution per model, shared by its operations; never retrieve credentials in the browser.
  const availability = await Promise.all(
    ["image", "video"].map(async (kind) => {
      try {
        await resolveStudioProviderRoute(
          kind === "image" ? "google-image-generate" : "google-video-text",
          ctx,
        );
        return [kind, undefined] as const;
      } catch (error) {
        return [
          kind,
          error instanceof StudioProviderError
            ? error.message
            : "Settings could not verify this provider. Try again when it is available.",
        ] as const;
      }
    }),
  );
  return STUDIO_CAPABILITIES.map((cap) => {
    const reason = cap.demo
      ? undefined
      : availability.find(([kind]) => kind === cap.mediaKind)?.[1];
    const { unavailableReason: _old, ...definition } = cap;
    return {
      ...definition,
      available: !reason,
      ...(reason ? { unavailableReason: reason } : {}),
    };
  });
}

async function apiKeyFor(
  route: StudioProviderRoute,
  ctx: StudioProviderContext,
): Promise<string> {
  if (route.ownerKey !== ownerKey(ctx))
    throw new StudioProviderError(
      "owner_mismatch",
      "This provider operation belongs to another workspace owner.",
      "rejected",
    );
  if (route.provider !== "google")
    throw new StudioProviderError(
      "invalid_route",
      "This operation does not use a Google credential.",
      "rejected",
    );
  if (route.credentialSource === "deployment_environment") {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key)
      throw new StudioProviderError(
        "credential_unavailable",
        "The original Google deployment credential is no longer available.",
        "rejected",
      );
    return key;
  }
  if (route.credentialSource !== "tenant_vault" || !route.connectionId)
    throw new StudioProviderError(
      "invalid_route",
      "The original provider connection is missing.",
      "rejected",
    );
  const { connection, credentials } = await getProviderCredentials({
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    connectionId: route.connectionId,
  });
  if (
    connection.provider !== "google" ||
    connection.status !== "connected" ||
    !connection.enabled ||
    connection.credentialVersion !== route.credentialVersion ||
    !credentials.apiKey?.trim()
  )
    throw new StudioProviderError(
      "credential_changed",
      "The original provider credential changed. Reconnect the original provider account to recover this operation; do not regenerate it automatically.",
      "rejected",
    );
  return credentials.apiKey.trim();
}

/** Deterministic request construction: supported controls only, one output, no tools or implicit retries. */
export function buildStudioGoogleRequest(
  request: StudioProviderRequest,
): JsonObject {
  const cap = requiredCapability(request.capabilityId);
  const { issues, parameters } = validateStudioProviderInputs(request);
  if (issues.length)
    throw new StudioProviderError(
      issues[0].code,
      issues.map((i) => i.message).join(" "),
      "rejected",
    );
  if (cap.demo)
    throw new StudioProviderError(
      "invalid_provider",
      "Demo operations do not send provider requests.",
      "rejected",
    );
  const ordered = cap.inputRoles.flatMap((role) =>
    request.references.filter((r) => r.role === role.role),
  );
  return {
    model: cap.model,
    input: [
      ...ordered.map((r) => ({
        type: "image",
        mime_type: r.mediaType,
        data: Buffer.from(r.bytes).toString("base64"),
      })),
      {
        type: "text",
        text: renderStudioProviderPrompt(cap.id, request.prompt),
      },
    ],
    response_format:
      cap.mediaKind === "image"
        ? {
            type: "image",
            // ImageResponseFormat permits JPEG; ImageContent's wider input
            // MIME list does not describe the supported generation format.
            mime_type: "image/jpeg",
            aspect_ratio: parameters.aspectRatio,
            image_size: parameters.imageSize,
          }
        : {
            type: "video",
            aspect_ratio: parameters.aspectRatio,
            resolution: parameters.resolution,
          },
    generation_config: { max_output_tokens: OUTPUT_TOKEN_LIMIT[cap.mediaKind] },
    background: true,
    store: true,
    stream: false,
  };
}

export async function submitStudioProvider(
  request: StudioProviderRequest,
  ctx: StudioProviderContext,
): Promise<StudioProviderResult> {
  const cap = requiredCapability(request.capabilityId);
  const validation = validateStudioProviderInputs(request);
  if (validation.issues.length)
    throw new StudioProviderError(
      validation.issues[0].code,
      validation.issues.map((i) => i.message).join(" "),
      "rejected",
    );
  if (!/^[a-zA-Z0-9:_-]{1,320}$/.test(request.submissionKey))
    throw new StudioProviderError(
      "invalid_submission_key",
      "The saved attempt identity is invalid.",
      "rejected",
    );
  if (
    request.references.reduce((bytes, r) => bytes + r.bytes.byteLength, 0) >
    MAX_INPUT_BYTES
  )
    throw new StudioProviderError(
      "references_too_large",
      "Use references totaling no more than 16 MiB.",
      "rejected",
    );
  for (const ref of request.references) {
    if (
      !ref.assetId ||
      createHash("sha256").update(ref.bytes).digest("hex") !== ref.contentSha256
    )
      throw new StudioProviderError(
        "reference_changed",
        "A reference changed since this run was approved. Refresh the flow and try again.",
        "rejected",
      );
    assertMediaSignature(ref.bytes, ref.mediaType, "rejected");
  }
  const route = await resolveStudioProviderRoute(cap.id, ctx);
  if (
    !cap.demo &&
    (!request.route ||
      studioCanonicalJson(route) !== studioCanonicalJson(request.route))
  )
    throw new StudioProviderError(
      "route_changed",
      "The model or provider credential changed after the quote. Review a new quote before running.",
      "rejected",
    );
  if (ctx.signal?.aborted)
    throw new StudioProviderError(
      "canceled_before_submit",
      "Canceled before contacting the provider.",
      "rejected",
    );
  if (cap.demo) {
    const handle: StudioProviderHandle = {
      provider: "demo",
      model: cap.model,
      requestId: `demo:${request.submissionKey}:${validation.parameters.outputCount}`,
      capabilityId: cap.id,
      submissionKey: request.submissionKey,
      route,
    };
    return demoResult(handle);
  }
  const body = buildStudioGoogleRequest(request);
  const apiKey = await apiKeyFor(route, ctx);
  const response = await providerRequest("", "POST", apiKey, ctx, body, true);
  const requestId = typeof response.id === "string" ? response.id : "";
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(requestId))
    throw new StudioProviderError(
      "submission_receipt_missing",
      "The provider may have accepted this request but did not return a recoverable ID. This attempt will not be submitted again automatically.",
      "uncertain_submission",
    );
  const handle: StudioProviderHandle = {
    provider: "google",
    model: cap.model,
    requestId,
    capabilityId: cap.id,
    submissionKey: request.submissionKey,
    route,
  };
  return finishResult(response, handle);
}

export async function getStudioProviderStatus(
  handle: StudioProviderHandle,
  ctx: StudioProviderContext,
): Promise<StudioProviderResult> {
  assertHandle(handle, ctx);
  if (handle.provider === "demo") return demoResult(handle);
  const key = await apiKeyFor(handle.route, ctx);
  return finishResult(
    await providerRequest(
      `/${encodeURIComponent(handle.requestId)}`,
      "GET",
      key,
      ctx,
    ),
    handle,
  );
}

export async function cancelStudioProvider(
  handle: StudioProviderHandle,
  ctx: StudioProviderContext,
): Promise<StudioProviderResult> {
  assertHandle(handle, ctx);
  if (handle.provider === "demo")
    return { status: "canceled", handle, error: "Demo attempt canceled." };
  const key = await apiKeyFor(handle.route, ctx);
  // A completion racing cancellation wins: preserve its paid output instead of claiming it never ran.
  return finishResult(
    await providerRequest(
      `/${encodeURIComponent(handle.requestId)}/cancel`,
      "POST",
      key,
      ctx,
      {},
    ),
    handle,
  );
}

function assertHandle(
  handle: StudioProviderHandle,
  ctx: StudioProviderContext,
) {
  const cap = requiredCapability(handle.capabilityId);
  if (
    handle.route.ownerKey !== ownerKey(ctx) ||
    handle.provider !== cap.provider ||
    handle.model !== cap.model ||
    handle.route.provider !== cap.provider ||
    handle.route.model !== cap.model ||
    (handle.provider === "google" &&
      !/^[a-zA-Z0-9_-]{1,512}$/.test(handle.requestId))
  )
    throw new StudioProviderError(
      "invalid_handle",
      "This saved provider operation is not valid for the current owner.",
      "rejected",
    );
}

function demoResult(handle: StudioProviderHandle): StudioProviderResult {
  const cap = requiredCapability(handle.capabilityId);
  const count =
    cap.mediaKind === "image"
      ? Math.min(
          3,
          Math.max(1, Number(handle.requestId.split(":").at(-1)) || 1),
        )
      : 1;
  return {
    status: "completed",
    handle,
    outputs: Array.from(
      { length: count },
      (_, index): StudioProviderOutputDescriptor => ({
        id: `output:${index + 1}`,
        filename:
          cap.mediaKind === "image"
            ? `demo-image-${index + 1}.png`
            : "demo-video.mp4",
        mediaType: cap.mediaKind === "image" ? "image/png" : "video/mp4",
        width: 960,
        height: 540,
        ...(cap.mediaKind === "video" ? { durationSeconds: 3 } : {}),
        demo: true,
        source: {
          kind: "fixture",
          name:
            cap.mediaKind === "image"
              ? (`image-${index + 1}.png` as "image-1.png")
              : "video.mp4",
        },
      }),
    ),
  };
}

async function providerRequest(
  suffix: string,
  method: string,
  apiKey: string,
  ctx: StudioProviderContext,
  body?: JsonObject,
  submission = false,
): Promise<JsonObject> {
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(GOOGLE_INTERACTIONS + suffix, {
      method,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": "2026-05-20",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new StudioProviderError(
      submission ? "submission_uncertain" : "provider_unreachable",
      submission
        ? "The connection ended before a provider receipt arrived. The request may be billable; it will not be submitted again automatically."
        : "The provider status could not be reached. Retry checking this saved operation.",
      submission ? "uncertain_submission" : "transient_poll",
    );
  }
  if (!response.ok) {
    const diagnostic = await rejectionDiagnostic(response);
    const definite = [400, 401, 403, 404, 413, 422, 429].includes(
      response.status,
    );
    throw new StudioProviderError(
      `provider_http_${response.status}`,
      rejectionMessage(diagnostic),
      submission
        ? definite
          ? "rejected"
          : "uncertain_submission"
        : "transient_poll",
      diagnostic,
    );
  }
  try {
    return object(
      JSON.parse(
        Buffer.from(await readBounded(response, MAX_RESPONSE_BYTES)).toString(
          "utf8",
        ),
      ),
    );
  } catch {
    throw new StudioProviderError(
      "invalid_provider_response",
      submission
        ? "The provider response could not be read. This submission is uncertain and will not be repeated automatically."
        : "The saved provider response could not be read. Retry status retrieval.",
      submission ? "uncertain_submission" : "transient_poll",
    );
  }
}

const DIAGNOSTIC_FIELDS: StudioProviderDiagnostic["fields"] = [
  "model",
  "input",
  "background",
  "store",
  "stream",
  "response_format",
  "response_format.aspect_ratio",
  "response_format.image_size",
  "response_format.mime_type",
  "response_format.resolution",
  "generation_config.max_output_tokens",
];

async function rejectionDiagnostic(
  response: Response,
): Promise<StudioProviderDiagnostic> {
  let failure: JsonObject = {};
  try {
    failure = object(
      object(
        JSON.parse(
          Buffer.from(
            await readBounded(response, MAX_ERROR_RESPONSE_BYTES),
          ).toString("utf8"),
        ),
      ).error,
    );
  } catch {
    // A malformed, oversized or interrupted diagnostic never changes the known
    // HTTP result into an ambiguous submission or causes another provider call.
  }
  const fields = new Set<StudioProviderDiagnostic["fields"][number]>();
  const details = Array.isArray(failure.details)
    ? failure.details.slice(0, 16).map(object)
    : [];
  const reasons = details
    .filter(
      (detail) =>
        detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
    )
    .map((detail) => detail.reason);
  const message =
    typeof failure.message === "string" ? failure.message.slice(0, 2_000) : "";
  let unsupported = false;
  for (const detail of details) {
    if (detail["@type"] !== "type.googleapis.com/google.rpc.BadRequest")
      continue;
    for (const raw of Array.isArray(detail.fieldViolations)
      ? detail.fieldViolations.slice(0, 16)
      : []) {
      const violation = object(raw);
      const field = DIAGNOSTIC_FIELDS.find((item) => item === violation.field);
      if (!field) continue;
      fields.add(field);
      if (
        typeof violation.description === "string" &&
        /\b(?:unsupported|not supported|unknown field|unknown name)\b/i.test(
          violation.description.slice(0, 500),
        )
      )
        unsupported = true;
    }
  }
  // Some Interactions errors contain only a message. Recognize a small set of
  // settings followed directly by a rejection; never copy arbitrary text.
  for (const field of DIAGNOSTIC_FIELDS) {
    const escaped = field.replaceAll(".", "\\.");
    if (
      new RegExp(
        `\\b${escaped}(?: mode| execution)?["']? (?:is |are )?(?:not supported|unsupported)\\b`,
        "i",
      ).test(message)
    ) {
      fields.add(field);
      unsupported = true;
    }
  }
  const status = response.status;
  const category: StudioProviderDiagnostic["category"] =
    status >= 500
      ? "upstream"
      : status === 429 || failure.status === "RESOURCE_EXHAUSTED"
        ? "quota"
        : reasons.includes("API_KEY_INVALID") ||
            reasons.includes("API_KEY_EXPIRED") ||
            status === 401 ||
            failure.status === "UNAUTHENTICATED" ||
            /\bAPI key (?:is )?(?:not valid|invalid|expired)\b/i.test(message)
          ? "credential"
          : reasons.includes("BILLING_DISABLED") ||
              reasons.includes("BILLING_NOT_ACTIVE")
            ? "billing"
            : status === 403 ||
                failure.status === "PERMISSION_DENIED" ||
                (status === 404 && fields.has("model"))
              ? "model_access"
              : reasons.includes("SAFETY") ||
                  reasons.includes("CONTENT_FILTERED")
                ? "safety"
                : unsupported
                  ? "unsupported_parameter"
                  : "invalid_request";
  return { httpStatus: status, category, fields: [...fields].sort() };
}

function rejectionMessage(diagnostic: StudioProviderDiagnostic): string {
  const messages: Record<StudioProviderDiagnostic["category"], string> = {
    credential:
      "Google rejected the API credential. Check the Google connection in Settings.",
    billing:
      "Google reports that billing is unavailable for this project. Check the provider account.",
    quota: "The provider rate or quota limit was reached.",
    model_access:
      "Google rejected access to this model or operation. Check the Google connection and model permissions.",
    unsupported_parameter:
      "Google reports an unsupported request setting. Asael kept the request limits and did not retry.",
    invalid_request:
      "Google rejected the request. Its specific cause was not retained unless a setting is listed below.",
    safety: "Google reports that its content policy blocked this request.",
    upstream:
      "Google returned a server failure. Acceptance is unknown; no new generation was requested.",
  };
  return `${messages[diagnostic.category]}${diagnostic.fields.length ? ` Settings: ${diagnostic.fields.join(", ")}.` : ""} HTTP ${diagnostic.httpStatus}.`;
}

function finishResult(
  body: JsonObject,
  handle: StudioProviderHandle,
): StudioProviderResult {
  if (
    (body.id && body.id !== handle.requestId) ||
    (body.model && body.model !== handle.model)
  )
    return {
      status: "failed",
      handle,
      error:
        "The provider returned a receipt for a different request or model. The original operation ID is preserved; no automatic regeneration is allowed.",
    };
  const status = body.status;
  if (status === "in_progress" || status === "pending" || status === "running")
    return { status: "running", handle };
  const usageBody = object(body.usage);
  const number = (key: string) =>
    typeof usageBody[key] === "number" &&
    Number.isFinite(usageBody[key]) &&
    usageBody[key] >= 0
      ? (usageBody[key] as number)
      : undefined;
  const usage = {
    inputTokens: number("total_input_tokens"),
    outputTokens: number("total_output_tokens"),
    totalTokens: number("total_tokens"),
    reasoningTokens: number("total_thought_tokens"),
  };
  const cap = requiredCapability(handle.capabilityId);
  let result: StudioProviderResult;
  if (status === "cancelled" || status === "canceled") {
    result = {
      status: "canceled",
      handle,
      error:
        "The provider confirmed cancellation. Work already performed may still be billed.",
    };
  } else if (status === "completed") {
    const outputs: StudioProviderOutputDescriptor[] = [];
    for (const step of Array.isArray(body.steps) ? body.steps : []) {
      const item = object(step);
      if (item.type !== "model_output" || !Array.isArray(item.content))
        continue;
      for (const raw of item.content) {
        const content = object(raw);
        if (content.type !== cap.mediaKind) continue;
        const mime = content.mime_type;
        if (
          typeof mime !== "string" ||
          !(
            cap.mediaKind === "image"
              ? ["image/png", "image/jpeg", "image/webp"]
              : ["video/mp4", "video/webm"]
          ).includes(mime)
        )
          continue;
        const source =
          typeof content.data === "string"
            ? { kind: "inline" as const, base64: content.data }
            : typeof content.uri === "string"
              ? { kind: "remote" as const, url: content.uri }
              : undefined;
        if (!source) continue;
        outputs.push({
          id: `output:${outputs.length + 1}`,
          filename: `studio-${handle.requestId.slice(0, 40)}.${mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1]}`,
          mediaType: mime as StudioProviderOutputDescriptor["mediaType"],
          source,
          demo: false,
        });
      }
    }
    result =
      outputs.length === 1
        ? { status: "completed", handle, outputs, usage }
        : {
            status: "failed",
            handle,
            error: outputs.length
              ? "The provider returned an unexpected output count. No new generation will be started automatically."
              : "The provider completed without a usable media output. Check its moderation result before choosing to regenerate.",
          };
  } else {
    const error = object(body.error);
    const codes = [
      error.code,
      ...(Array.isArray(body.errors) ? body.errors : []).map(
        (e) => object(e).code,
      ),
    ]
      .map(String)
      .join(" ");
    const moderated = /safety|moderation|blocked|prohibited/i.test(codes);
    result = {
      status: moderated ? "moderated" : "failed",
      handle,
      error: moderated
        ? "The provider blocked this request under its content policy. Review the prompt or references."
        : status === "incomplete"
          ? "The provider reached the bounded output-token limit before completing media. No extra generation was requested."
          : "The provider could not complete this media request. No automatic regeneration was attempted.",
    };
  }
  return { ...result, usage };
}

/** The caller must persist the provider result first. Safe to replay after a worker restart. */
export async function recordStudioProviderUsage(
  result: StudioProviderResult,
  ctx: StudioProviderContext,
) {
  const handle = result.handle;
  assertHandle(handle, ctx);
  if (handle.provider === "demo" || result.status === "running") return;
  const cap = requiredCapability(handle.capabilityId);
  // Stable attempt identity makes status/retrieval replay a single ledger entry.
  await recordAiUsageSafely({
    id: `studio_usage_${createHash("sha256").update(`${handle.route.ownerKey}:${handle.submissionKey}`).digest("hex")}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    sourceStreamId: ctx.sourceStreamId || `studio:${handle.submissionKey}`,
    executionScope: ctx.executionScope,
    operation:
      cap.mediaKind === "image" ? "image_generation" : "video_generation",
    purpose: "Creative Studio generation",
    provider: "google",
    model: handle.model,
    providerRequestId: handle.requestId,
    status: result.status === "completed" ? "completed" : "failed",
    usage: result.usage,
    providerCallCount: 1,
    attemptCount: 1,
    failedAttemptCount: result.status === "completed" ? 0 : 1,
    assignmentId: handle.route.assignmentId,
    assignmentRevision: handle.route.assignmentRevision,
    assignmentConfigurationSha256: handle.route.assignmentConfigurationSha256,
    assignmentScope:
      cap.mediaKind === "image" ? "image_generation" : "video_generation",
    credentialSource:
      handle.route.credentialSource === "demo"
        ? undefined
        : handle.route.credentialSource,
  });
}

/** Called only after the descriptor was persisted. Repeating this never starts generation. */
export async function materializeStudioProviderOutput(
  descriptor: StudioProviderOutputDescriptor,
  ctx: StudioProviderContext,
): Promise<StudioMaterializedOutput> {
  ownerKey(ctx);
  let bytes: Uint8Array;
  try {
    if (descriptor.source.kind === "fixture") {
      if (
        !["image-1.png", "image-2.png", "image-3.png", "video.mp4"].includes(
          descriptor.source.name,
        ) ||
        !descriptor.demo
      )
        throw new Error("Invalid fixture.");
      bytes = Buffer.from(demoFixtures[descriptor.source.name], "base64");
    } else if (descriptor.source.kind === "inline") {
      const encoded = descriptor.source.base64;
      if (
        encoded.length > Math.ceil(STUDIO_MAX_OUTPUT_BYTES / 3) * 4 ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new Error("Invalid encoded media.");
      bytes = Buffer.from(encoded, "base64");
    } else {
      const url = new URL(descriptor.source.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        ![
          "storage.googleapis.com",
          "generativelanguage.googleapis.com",
          "googleusercontent.com",
        ].some(
          (host) =>
            url.hostname === host ||
            (host === "googleusercontent.com" &&
              url.hostname.endsWith(`.${host}`)),
        )
      )
        throw new Error("Invalid provider media host.");
      const response = await fetchPublicHttpUrl(
        url,
        {
          signal: ctx.signal
            ? AbortSignal.any([
                ctx.signal,
                AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "manual",
        },
        "Studio generated media",
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Provider media unavailable.");
      }
      bytes = await readBounded(response, STUDIO_MAX_OUTPUT_BYTES);
    }
  } catch {
    throw new StudioProviderError(
      "output_retrieval_failed",
      "The generated media could not be copied into your library. Retry saving this existing result; no new generation is needed.",
      "retrieval",
    );
  }
  if (!bytes.byteLength || bytes.byteLength > STUDIO_MAX_OUTPUT_BYTES)
    throw new StudioProviderError(
      "output_size",
      "The generated file exceeds the 20 MiB library limit. Its provider receipt is preserved; do not regenerate automatically.",
      "retrieval",
    );
  assertMediaSignature(bytes, descriptor.mediaType, "retrieval");
  const { source: _source, id: _id, ...metadata } = descriptor;
  return { ...metadata, bytes };
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maximum) {
    await response.body?.cancel();
    throw new Error("Response too large.");
  }
  if (!response.body) throw new Error("Missing response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw new Error("Response too large.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function assertMediaSignature(
  bytes: Uint8Array,
  mediaType: string,
  disposition: "retrieval" | "rejected",
) {
  const data = Buffer.from(bytes);
  const matches =
    mediaType === "image/png"
      ? data.length >= 24 &&
        data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === "image/jpeg"
        ? data.length >= 3 &&
          data[0] === 255 &&
          data[1] === 216 &&
          data[2] === 255
        : mediaType === "image/webp"
          ? data.length >= 12 &&
            data.toString("ascii", 0, 4) === "RIFF" &&
            data.toString("ascii", 8, 12) === "WEBP"
          : mediaType === "video/mp4"
            ? data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp"
            : mediaType === "video/webm"
              ? data.length >= 4 &&
                data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
              : false;
  if (!matches)
    throw new StudioProviderError(
      "invalid_media",
      "The file bytes do not match the declared media type.",
      disposition,
    );
}
