import { Buffer } from "node:buffer";
import {
  CaptureAssetError,
  deleteCaptureAsset,
  getCaptureAssetContent,
  listInternalCaptureAssets,
  saveCaptureAsset,
} from "@/lib/capture/assets";
import {
  callMcpTool,
  type McpSessionScope,
} from "@/lib/connectors/mcp-client";
import { isOmniAgentPlaywrightMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { getMcpConnector, parseMcpToolId } from "@/lib/connectors/store";
import { appendDomainEventSafely } from "@/lib/events/store";
import type { SecurityContext } from "@/lib/security/types";

const INTERNAL_KIND = "browserFrame";
const MAX_FRAME_BYTES = 1_500_000;
const MAX_FRAMES_PER_RUN = 24;
const FRAME_CAPTURE_TIMEOUT_MS = 8_000;
const CAPTURED_OPERATIONS = new Set([
  "browser_click",
  "browser_drag",
  "browser_find",
  "browser_handle_dialog",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_press_key",
  "browser_resize",
  "browser_select_option",
  "browser_snapshot",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_wait_for",
]);
const SENSITIVE_ENTRY_OPERATIONS = new Set([
  "browser_file_upload",
  "browser_fill_form",
  "browser_type",
]);
const FRAME_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type BrowserFrameSummary = {
  id: string;
  at: string;
  mimeType: string;
  byteCount: number;
  executionId: string;
  operation: string;
  pageOrigin?: string;
  pageTitle?: string;
};

export async function captureBrowserFrameAfterToolSafely(input: {
  toolId: string;
  toolInput: Record<string, unknown>;
  toolResult?: unknown;
  executionId: string;
  context?: SecurityContext;
  sessionScope?: McpSessionScope;
  abortSignal?: AbortSignal;
}) {
  const scope = input.sessionScope;
  const runId = scope ? agentRunId(scope.executionId) : undefined;
  if (!scope || !runId) return undefined;

  let parsed: ReturnType<typeof parseMcpToolId>;
  try {
    parsed = parseMcpToolId(input.toolId);
  } catch {
    return undefined;
  }
  const operation = parsed?.toolName.trim().toLowerCase();
  if (!parsed || !operation) return undefined;

  const sensitiveEntry = SENSITIVE_ENTRY_OPERATIONS.has(operation);
  if (!sensitiveEntry && !CAPTURED_OPERATIONS.has(operation)) return undefined;

  try {
    assertMatchingScope(scope, input.context);
    const connector = await getMcpConnector(parsed.connectorId, {
      tenantId: scope.tenantId,
    });
    if (
      !connector ||
      connector.status !== "active" ||
      !isOmniAgentPlaywrightMcpEndpoint(connector.endpoint)
    ) {
      return undefined;
    }
    if (sensitiveEntry) {
      await appendFrameEvent({
        runId,
        scope,
        type: "browser.frame.suppressed",
        payload: {
          executionId: input.executionId,
          operation,
          reason: "sensitive_entry",
        },
      });
      return undefined;
    }

    // This is bounded observability attached to an already-governed browser
    // action, not a model-requested action or an alternate execution path.
    const result = await callMcpTool({
      connector,
      toolName: "browser_take_screenshot",
      args: { type: "webp", scale: "css" },
      idempotencyKey: `browser-frame:${input.executionId}`,
      actorRole: input.context?.role,
      abortSignal: frameCaptureSignal(input.abortSignal),
      sessionScope: scope,
      includeImages: true,
    });
    const image = browserImage(result);
    const bytes = decodeFrame(image.data, image.mimeType);
    const actionPage = browserPage(input.toolResult);
    const screenshotPage = browserPage(result);
    const fallbackUrl = operation === "browser_navigate"
      ? safePageUrl(input.toolInput.url)
      : undefined;
    const pageUrl = actionPage.url || screenshotPage.url || fallbackUrl;
    const pageTitle = actionPage.title || screenshotPage.title;
    const pageOrigin = pageUrl ? safeOrigin(pageUrl) : undefined;
    const asset = await saveCaptureAsset({
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      filename: `browser-${runId}-${Date.now()}.${extensionForMime(image.mimeType)}`,
      mediaType: image.mimeType,
      bytes,
      tags: ["browser", "run-evidence"],
      metadata: {
        internalKind: INTERNAL_KIND,
        runId,
        executionId: input.executionId,
        operation,
        pageOrigin,
        pageTitle,
        pageUrl,
      },
    });
    const frame = browserFrameFromAsset(asset);
    await appendFrameEvent({
      runId,
      scope,
      type: "browser.frame.captured",
      payload: {
        assetId: asset.id,
        executionId: input.executionId,
        operation,
        mimeType: asset.mediaType,
        byteCount: asset.byteCount,
        pageOrigin,
      },
    });
    await pruneRunFrames(runId, scope).catch(() => undefined);
    return frame;
  } catch (error) {
    await appendFrameEvent({
      runId,
      scope,
      type: "browser.frame.failed",
      payload: {
        executionId: input.executionId,
        operation,
        category: frameFailureCategory(error),
      },
    });
    return undefined;
  }
}

export async function listRunBrowserFrames(
  runId: string,
  owner: { tenantId: string; actorId: string },
): Promise<BrowserFrameSummary[]> {
  const assets = await listInternalCaptureAssets(owner, {
    kind: INTERNAL_KIND,
    scopeField: "runId",
    scopeValue: runId,
    limit: MAX_FRAMES_PER_RUN,
  });
  return assets
    .map(browserFrameFromAsset)
    .filter((frame): frame is BrowserFrameSummary => frame !== undefined)
    .sort((left, right) => left.at.localeCompare(right.at));
}

export async function getRunBrowserFrameContent(
  runId: string,
  frameId: string,
  owner: { tenantId: string; actorId: string },
) {
  let content: Awaited<ReturnType<typeof getCaptureAssetContent>>;
  try {
    content = await getCaptureAssetContent(frameId, owner);
  } catch (error) {
    if (error instanceof CaptureAssetError) return undefined;
    throw error;
  }
  if (
    stringMetadata(content.asset.metadata, "internalKind") !== INTERNAL_KIND ||
    stringMetadata(content.asset.metadata, "runId") !== runId
  ) {
    return undefined;
  }
  return content;
}

function browserFrameFromAsset(
  asset: Awaited<ReturnType<typeof saveCaptureAsset>>,
): BrowserFrameSummary | undefined {
  const executionId = stringMetadata(asset.metadata, "executionId");
  const operation = stringMetadata(asset.metadata, "operation");
  if (!executionId || !operation) return undefined;
  return {
    id: asset.id,
    at: asset.createdAt,
    mimeType: asset.mediaType,
    byteCount: asset.byteCount,
    executionId,
    operation,
    pageOrigin: stringMetadata(asset.metadata, "pageOrigin"),
    pageTitle: stringMetadata(asset.metadata, "pageTitle"),
  };
}

async function pruneRunFrames(runId: string, scope: McpSessionScope) {
  const frames = await listInternalCaptureAssets(
    { tenantId: scope.tenantId, actorId: scope.actorId },
    {
      kind: INTERNAL_KIND,
      scopeField: "runId",
      scopeValue: runId,
      limit: MAX_FRAMES_PER_RUN + 24,
    },
  );
  await Promise.all(
    frames.slice(MAX_FRAMES_PER_RUN).map((frame) =>
      deleteCaptureAsset(frame.id, {
        tenantId: scope.tenantId,
        actorId: scope.actorId,
      }),
    ),
  );
}

async function appendFrameEvent(input: {
  runId: string;
  scope: McpSessionScope;
  type: "browser.frame.captured" | "browser.frame.failed" | "browser.frame.suppressed";
  payload: Record<string, unknown>;
}) {
  await appendDomainEventSafely({
    streamId: `run:${input.runId}`,
    type: input.type,
    tenantId: input.scope.tenantId,
    actorId: input.scope.actorId,
    causationId: stringMetadata(input.payload, "executionId"),
    correlationId: input.runId,
    payload: input.payload,
  });
}

function browserImage(value: unknown) {
  const result = record(value);
  const image = Array.isArray(result.content)
    ? result.content.find((item) =>
        record(item).type === "image" && typeof record(item).data === "string"
      )
    : undefined;
  const parsed = record(image);
  const data = typeof parsed.data === "string" ? parsed.data : "";
  const mimeType = typeof parsed.mimeType === "string"
    ? parsed.mimeType.trim().toLowerCase()
    : "";
  if (!data || !FRAME_MIME_TYPES.has(mimeType)) {
    throw new Error("Browser screenshot did not contain a supported image.");
  }
  return { data, mimeType };
}

function decodeFrame(data: string, mimeType: string) {
  if (data.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 8) {
    throw new Error("Browser screenshot exceeded the evidence size limit.");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_FRAME_BYTES || !hasImageSignature(bytes, mimeType)) {
    throw new Error("Browser screenshot data was invalid.");
  }
  return bytes;
}

function hasImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function browserPage(value: unknown) {
  const root = record(value);
  const result = Array.isArray(root.content) ? root : record(root.result);
  const text = Array.isArray(result.content)
    ? result.content
        .map((item) => record(item))
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => String(item.text))
        .join("\n")
    : "";
  const rawUrl = /^- Page URL:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const rawTitle = /^- Page Title:\s*(.+)$/im.exec(text)?.[1]?.trim();
  return {
    url: safePageUrl(rawUrl),
    title: safeText(rawTitle, 240),
  };
}

function safePageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return undefined;
  }
}

function safeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function extensionForMime(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  return "webp";
}

function agentRunId(executionId: string) {
  if (!executionId.startsWith("agent:")) return undefined;
  const value = executionId.slice("agent:".length).trim();
  return /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

function assertMatchingScope(scope: McpSessionScope, context?: SecurityContext) {
  if (context?.tenantId && normalizeTenant(context.tenantId) !== normalizeTenant(scope.tenantId)) {
    throw new Error("Browser evidence scope did not match the tool tenant.");
  }
  if (context?.actorId && context.actorId.trim() !== scope.actorId.trim()) {
    throw new Error("Browser evidence scope did not match the tool actor.");
  }
}

function frameCaptureSignal(parent?: AbortSignal) {
  const timeout = AbortSignal.timeout(FRAME_CAPTURE_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function normalizeTenant(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) || undefined : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function frameFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/abort|cancel/.test(message)) return "cancelled";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/size limit|too large|exceeded/.test(message)) return "too_large";
  if (/scope|tenant/.test(message)) return "scope_mismatch";
  if (/image|screenshot/.test(message)) return "image_unavailable";
  return "capture_unavailable";
}
