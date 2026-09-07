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
import { isAsaelPlaywrightMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { getMcpConnector, parseMcpToolId } from "@/lib/connectors/store";
import { appendDomainEventSafely } from "@/lib/events/store";
import type { ModelBrowserObservation } from "@/lib/models/browser-observation";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { redactSensitive } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";

const FRAME_INTERNAL_KIND = "browserFrame";
const SNAPSHOT_INTERNAL_KIND = "browserAccessibilitySnapshot";
const MAX_FRAME_BYTES = 1_500_000;
const MAX_SNAPSHOT_BYTES = 160_000;
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

export type BrowserAccessibilitySnapshotSummary = {
  id: string;
  at: string;
  mimeType: "text/plain";
  byteCount: number;
  contentSha256: string;
  executionId: string;
  operation: string;
};

export type BrowserObservationCapture = Readonly<{
  frame?: BrowserFrameSummary;
  accessibilitySnapshot?: BrowserAccessibilitySnapshotSummary;
  /** Ephemeral provider input. This is deliberately absent from stored events. */
  modelObservation?: ModelBrowserObservation;
}>;

export async function captureBrowserFrameAfterToolSafely(input: {
  toolId: string;
  toolInput: Record<string, unknown>;
  toolResult?: unknown;
  executionId: string;
  executionScope: ExecutionScope;
  context?: SecurityContext;
  sessionScope?: McpSessionScope;
  abortSignal?: AbortSignal;
}): Promise<BrowserObservationCapture | undefined> {
  const scope = input.sessionScope;
  const runId = scope ? agentRunId(scope.executionId) : undefined;
  if (!scope || !runId) return undefined;
  let executionScope: ExecutionScope;
  try {
    executionScope = deriveExecutionScope(input.executionScope, {
      executingPrincipalType: "system",
      executingPrincipalId: "browser-frame-recorder",
      causationId: input.executionId,
      purpose: "browser.frame.capture",
    });
  } catch {
    return undefined;
  }

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
    assertMatchingScope(scope, executionScope, input.context);
    const connector = await getMcpConnector(parsed.connectorId, {
      tenantId: scope.tenantId,
    });
    if (
      !connector ||
      connector.status !== "active" ||
      !isAsaelPlaywrightMcpEndpoint(connector.endpoint)
    ) {
      return undefined;
    }
    if (sensitiveEntry) {
      await appendObservationEvent({
        runId,
        scope,
        executionScope,
        type: "browser.frame.suppressed",
        payload: {
          executionId: input.executionId,
          operation,
          reason: "sensitive_entry",
        },
      });
      await appendObservationEvent({
        runId,
        scope,
        executionScope,
        type: "browser.snapshot.suppressed",
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
    const frameCapture = await captureFrame({
      connector,
      runId,
      operation,
      toolInput: input.toolInput,
      toolResult: input.toolResult,
      executionId: input.executionId,
      executionScope,
      context: input.context,
      sessionScope: scope,
      abortSignal: input.abortSignal,
    }).catch(async (error) => {
      await appendObservationEvent({
        runId,
        scope,
        executionScope,
        type: "browser.frame.failed",
        payload: {
          executionId: input.executionId,
          operation,
          category: frameFailureCategory(error),
        },
      });
      return undefined;
    });
    const snapshotCapture = await captureAccessibilitySnapshot({
      connector,
      runId,
      operation,
      toolResult: input.toolResult,
      executionId: input.executionId,
      executionScope,
      context: input.context,
      sessionScope: scope,
      abortSignal: input.abortSignal,
    }).catch(async (error) => {
      await appendObservationEvent({
        runId,
        scope,
        executionScope,
        type: "browser.snapshot.failed",
        payload: {
          executionId: input.executionId,
          operation,
          category: snapshotFailureCategory(error),
        },
      });
      return undefined;
    });
    await pruneRunObservations(runId, scope, executionScope).catch(() => undefined);
    const actionPage = browserPage(input.toolResult);
    const fallbackUrl = operation === "browser_navigate"
      ? safePageUrl(input.toolInput.url)
      : undefined;
    const pageUrl = frameCapture?.pageState.url || actionPage.url || fallbackUrl;
    const pageTitle = frameCapture?.pageState.title || actionPage.title;
    const modelObservation = frameCapture || snapshotCapture || pageUrl || pageTitle
      ? {
          schemaVersion: 1 as const,
          source: "browser" as const,
          trust: "untrusted_data" as const,
          executionId: input.executionId,
          operation,
          ...(
            pageUrl || pageTitle
              ? {
                  pageState: {
                    ...(pageUrl ? { url: pageUrl, origin: safeOrigin(pageUrl) } : {}),
                    ...(pageTitle ? { title: pageTitle } : {}),
                  },
                }
              : {}
          ),
          ...(snapshotCapture?.content
            ? { accessibilitySnapshot: snapshotCapture.content }
            : {}),
          ...(frameCapture?.screenshot
            ? { screenshot: frameCapture.screenshot }
            : {}),
        } satisfies ModelBrowserObservation
      : undefined;
    return {
      ...(frameCapture?.frame ? { frame: frameCapture.frame } : {}),
      ...(snapshotCapture?.summary
        ? { accessibilitySnapshot: snapshotCapture.summary }
        : {}),
      ...(modelObservation ? { modelObservation } : {}),
    };
  } catch (error) {
    await appendObservationEvent({
      runId,
      scope,
      executionScope,
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
    kind: FRAME_INTERNAL_KIND,
    scopeField: "runId",
    scopeValue: runId,
    limit: MAX_FRAMES_PER_RUN,
  });
  return assets
    .map(browserFrameFromAsset)
    .filter((frame): frame is BrowserFrameSummary => frame !== undefined)
    .sort((left, right) => left.at.localeCompare(right.at));
}

export async function listRunBrowserAccessibilitySnapshots(
  runId: string,
  owner: { tenantId: string; actorId: string },
): Promise<BrowserAccessibilitySnapshotSummary[]> {
  const assets = await listInternalCaptureAssets(owner, {
    kind: SNAPSHOT_INTERNAL_KIND,
    scopeField: "runId",
    scopeValue: runId,
    limit: MAX_FRAMES_PER_RUN,
  });
  return assets
    .map(browserSnapshotFromAsset)
    .filter((snapshot): snapshot is BrowserAccessibilitySnapshotSummary =>
      snapshot !== undefined
    )
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
    stringMetadata(content.asset.metadata, "internalKind") !== FRAME_INTERNAL_KIND ||
    stringMetadata(content.asset.metadata, "runId") !== runId
  ) {
    return undefined;
  }
  return content;
}

export async function getRunBrowserAccessibilitySnapshotContent(
  runId: string,
  snapshotId: string,
  owner: { tenantId: string; actorId: string },
) {
  let content: Awaited<ReturnType<typeof getCaptureAssetContent>>;
  try {
    content = await getCaptureAssetContent(snapshotId, owner);
  } catch (error) {
    if (error instanceof CaptureAssetError) return undefined;
    throw error;
  }
  if (
    stringMetadata(content.asset.metadata, "internalKind") !== SNAPSHOT_INTERNAL_KIND ||
    stringMetadata(content.asset.metadata, "runId") !== runId ||
    content.asset.mediaType !== "text/plain"
  ) {
    return undefined;
  }
  return content;
}

/**
 * Rehydrates one exact execution's private browser evidence for an approval
 * resume. The result is still ephemeral and must not be stored in continuation
 * state or general tool transcripts.
 */
export async function loadRunBrowserModelObservation(
  runId: string,
  executionId: string,
  owner: { tenantId: string; actorId: string },
): Promise<ModelBrowserObservation | undefined> {
  const [frames, snapshots] = await Promise.all([
    listRunBrowserFrames(runId, owner),
    listRunBrowserAccessibilitySnapshots(runId, owner),
  ]);
  const frame = frames.find((item) => item.executionId === executionId);
  const snapshot = snapshots.find((item) => item.executionId === executionId);
  if (!frame && !snapshot) return undefined;
  const [frameContent, snapshotContent] = await Promise.all([
    frame ? getRunBrowserFrameContent(runId, frame.id, owner) : undefined,
    snapshot
      ? getRunBrowserAccessibilitySnapshotContent(runId, snapshot.id, owner)
      : undefined,
  ]);
  const operation = frame?.operation || snapshot?.operation;
  if (!operation) return undefined;
  const pageUrl = frameContent
    ? safePageUrl(stringMetadata(frameContent.asset.metadata, "pageUrl"))
    : undefined;
  const pageOrigin = frame?.pageOrigin || (pageUrl ? safeOrigin(pageUrl) : undefined);
  const pageTitle = frame?.pageTitle;
  const accessibilitySnapshot = snapshotContent
    ? snapshotContent.bytes.toString("utf8").trim()
    : undefined;
  return {
    schemaVersion: 1,
    source: "browser",
    trust: "untrusted_data",
    executionId,
    operation,
    ...(pageUrl || pageOrigin || pageTitle
      ? {
          pageState: {
            ...(pageUrl ? { url: pageUrl } : {}),
            ...(pageOrigin ? { origin: pageOrigin } : {}),
            ...(pageTitle ? { title: pageTitle } : {}),
          },
        }
      : {}),
    ...(accessibilitySnapshot ? { accessibilitySnapshot } : {}),
    ...(frameContent && FRAME_MIME_TYPES.has(frameContent.asset.mediaType)
      ? {
          screenshot: {
            mimeType: frameContent.asset.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/webp",
            dataBase64: frameContent.bytes.toString("base64"),
          },
        }
      : {}),
  };
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

function browserSnapshotFromAsset(
  asset: Awaited<ReturnType<typeof saveCaptureAsset>>,
): BrowserAccessibilitySnapshotSummary | undefined {
  const executionId = stringMetadata(asset.metadata, "executionId");
  const operation = stringMetadata(asset.metadata, "operation");
  if (!executionId || !operation || asset.mediaType !== "text/plain") {
    return undefined;
  }
  return {
    id: asset.id,
    at: asset.createdAt,
    mimeType: "text/plain",
    byteCount: asset.byteCount,
    contentSha256: asset.contentSha256,
    executionId,
    operation,
  };
}

async function captureFrame(input: {
  connector: NonNullable<Awaited<ReturnType<typeof getMcpConnector>>>;
  runId: string;
  operation: string;
  toolInput: Record<string, unknown>;
  toolResult?: unknown;
  executionId: string;
  executionScope: ExecutionScope;
  context?: SecurityContext;
  sessionScope: McpSessionScope;
  abortSignal?: AbortSignal;
}) {
  const result = await callMcpTool({
    connector: input.connector,
    toolName: "browser_take_screenshot",
    args: { type: "webp", scale: "css" },
    idempotencyKey: `browser-frame:${input.executionId}`,
    actorRole: input.context?.role,
    abortSignal: frameCaptureSignal(input.abortSignal),
    sessionScope: input.sessionScope,
    includeImages: true,
  });
  const image = browserImage(result);
  const bytes = decodeFrame(image.data, image.mimeType);
  const actionPage = browserPage(input.toolResult);
  const screenshotPage = browserPage(result);
  const fallbackUrl = input.operation === "browser_navigate"
    ? safePageUrl(input.toolInput.url)
    : undefined;
  const pageUrl = actionPage.url || screenshotPage.url || fallbackUrl;
  const pageTitle = actionPage.title || screenshotPage.title;
  const pageOrigin = pageUrl ? safeOrigin(pageUrl) : undefined;
  const asset = await saveCaptureAsset({
    tenantId: input.sessionScope.tenantId,
    actorId: input.sessionScope.actorId,
    executionScope: input.executionScope,
    filename: `browser-${input.runId}-${Date.now()}.${extensionForMime(image.mimeType)}`,
    mediaType: image.mimeType,
    bytes,
    tags: ["browser", "run-evidence"],
    metadata: {
      internalKind: FRAME_INTERNAL_KIND,
      runId: input.runId,
      executionId: input.executionId,
      operation: input.operation,
      pageOrigin,
      pageTitle,
      pageUrl,
    },
  });
  const frame = browserFrameFromAsset(asset);
  await appendObservationEvent({
    runId: input.runId,
    scope: input.sessionScope,
    executionScope: input.executionScope,
    type: "browser.frame.captured",
    payload: {
      assetId: asset.id,
      executionId: input.executionId,
      operation: input.operation,
      mimeType: asset.mediaType,
      byteCount: asset.byteCount,
      pageOrigin,
    },
  });
  return {
    frame,
    screenshot: {
      mimeType: image.mimeType as "image/jpeg" | "image/png" | "image/webp",
      dataBase64: bytes.toString("base64"),
    },
    pageState: {
      ...(pageUrl ? { url: pageUrl } : {}),
      ...(pageOrigin ? { origin: pageOrigin } : {}),
      ...(pageTitle ? { title: pageTitle } : {}),
    },
  };
}

async function captureAccessibilitySnapshot(input: {
  connector: NonNullable<Awaited<ReturnType<typeof getMcpConnector>>>;
  runId: string;
  operation: string;
  toolResult?: unknown;
  executionId: string;
  executionScope: ExecutionScope;
  context?: SecurityContext;
  sessionScope: McpSessionScope;
  abortSignal?: AbortSignal;
}) {
  let snapshot = extractRedactedAccessibilitySnapshot(input.toolResult);
  if (!snapshot) {
    const result = await callMcpTool({
      connector: input.connector,
      toolName: "browser_snapshot",
      args: {},
      idempotencyKey: `browser-snapshot:${input.executionId}`,
      actorRole: input.context?.role,
      abortSignal: frameCaptureSignal(input.abortSignal),
      sessionScope: input.sessionScope,
    });
    snapshot = extractRedactedAccessibilitySnapshot(result);
  }
  if (!snapshot) {
    throw new Error("Browser accessibility snapshot was unavailable.");
  }
  const bytes = Buffer.from(snapshot, "utf8");
  if (!bytes.byteLength || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("Browser accessibility snapshot exceeded the evidence size limit.");
  }
  const asset = await saveCaptureAsset({
    tenantId: input.sessionScope.tenantId,
    actorId: input.sessionScope.actorId,
    executionScope: input.executionScope,
    filename: `browser-${input.runId}-${Date.now()}-accessibility.txt`,
    mediaType: "text/plain",
    bytes,
    tags: ["browser", "run-evidence", "accessibility-snapshot"],
    metadata: {
      internalKind: SNAPSHOT_INTERNAL_KIND,
      runId: input.runId,
      executionId: input.executionId,
      operation: input.operation,
      redactionVersion: "p9.5-browser-snapshot-redaction:1",
    },
  });
  await appendObservationEvent({
    runId: input.runId,
    scope: input.sessionScope,
    executionScope: input.executionScope,
    type: "browser.snapshot.captured",
    payload: {
      assetId: asset.id,
      executionId: input.executionId,
      operation: input.operation,
      byteCount: asset.byteCount,
      contentSha256: asset.contentSha256,
      redactionVersion: "p9.5-browser-snapshot-redaction:1",
    },
  });
  return {
    summary: browserSnapshotFromAsset(asset),
    content: snapshot,
  };
}

async function pruneRunObservations(
  runId: string,
  scope: McpSessionScope,
  executionScope: ExecutionScope,
) {
  const owner = { tenantId: scope.tenantId, actorId: scope.actorId };
  const [frames, snapshots] = await Promise.all([
    listInternalCaptureAssets(owner, {
      kind: FRAME_INTERNAL_KIND,
      scopeField: "runId",
      scopeValue: runId,
      limit: MAX_FRAMES_PER_RUN + 24,
    }),
    listInternalCaptureAssets(owner, {
      kind: SNAPSHOT_INTERNAL_KIND,
      scopeField: "runId",
      scopeValue: runId,
      limit: MAX_FRAMES_PER_RUN + 24,
    }),
  ]);
  await Promise.all(
    [...frames.slice(MAX_FRAMES_PER_RUN), ...snapshots.slice(MAX_FRAMES_PER_RUN)]
      .map((observation) =>
        deleteCaptureAsset(observation.id, {
          tenantId: scope.tenantId,
          actorId: scope.actorId,
          executionScope: deriveExecutionScope(executionScope, {
            causationId: observation.id,
            purpose: "browser.observation.retention_prune",
          }),
        }),
    ),
  );
}

async function appendObservationEvent(input: {
  runId: string;
  scope: McpSessionScope;
  executionScope: ExecutionScope;
  type:
    | "browser.frame.captured"
    | "browser.frame.failed"
    | "browser.frame.suppressed"
    | "browser.snapshot.captured"
    | "browser.snapshot.failed"
    | "browser.snapshot.suppressed";
  payload: Record<string, unknown>;
}) {
  await appendDomainEventSafely({
    streamId: `run:${input.runId}`,
    type: input.type,
    tenantId: input.scope.tenantId,
    actorId: input.scope.actorId,
    causationId: input.executionScope.causationId || undefined,
    correlationId: input.executionScope.correlationId,
    payload: input.payload,
    executionScope: input.executionScope,
  });
}

export function extractRedactedAccessibilitySnapshot(value: unknown) {
  const root = record(value);
  const result = Array.isArray(root.content) ? root : record(root.result);
  const text = Array.isArray(result.content)
    ? result.content
        .map((item) => record(item))
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => String(item.text))
        .join("\n")
    : "";
  const snapshot = extractSnapshotSection(text);
  if (!snapshot) return undefined;
  const redacted = redactSensitive(
    snapshot
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map(redactAccessibilityLine)
      .join("\n"),
  );
  if (typeof redacted !== "string") return undefined;
  const normalized = redacted.trim();
  if (!normalized) return undefined;
  return truncateUtf8(normalized, MAX_SNAPSHOT_BYTES);
}

function extractSnapshotSection(text: string) {
  const fenced = /- Page Snapshot:\s*```(?:yaml)?\s*\n([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced?.trim()) return fenced.trim();
  const pageSnapshot = /- Page Snapshot:\s*\n([\s\S]*)/i.exec(text)?.[1];
  if (pageSnapshot?.trim()) return pageSnapshot.trim();
  const headingSnapshot = /### (?:Accessibility |Page )?Snapshot\s*\n([\s\S]*)/i.exec(text)?.[1];
  return headingSnapshot?.trim() || undefined;
}

function redactAccessibilityLine(line: string) {
  const sensitiveControl = /\b(password|passcode|one[- ]?time|otp|verification code|security code|cvv|cvc|card number|api key|access token|secret|social security|ssn)\b/i;
  if (sensitiveControl.test(line)) {
    const indent = /^\s*/.exec(line)?.[0] || "";
    const marker = line.trimStart().startsWith("-") ? "- " : "";
    return `${indent}${marker}[redacted sensitive control]`;
  }
  return line
    .replace(/(\bvalue\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s\]]+)/gi, "$1[redacted]")
    .replace(/(\b(?:typed|input)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s\]]+)/gi, "$1[redacted]");
}

function truncateUtf8(value: string, limit: number) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "\n[truncated accessibility snapshot]";
  const bytes = Buffer.from(value, "utf8");
  const bounded = bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(suffix)));
  return `${bounded.toString("utf8").replace(/\uFFFD+$/g, "")}${suffix}`;
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

function assertMatchingScope(
  scope: McpSessionScope,
  executionScope: ExecutionScope,
  context?: SecurityContext,
) {
  assertExecutionScopeTenant(executionScope, normalizeTenant(scope.tenantId));
  if (executionScope.initiatingActorId !== scope.actorId.trim()) {
    throw new Error("Browser evidence execution scope did not match the tool actor.");
  }
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

function snapshotFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/abort|cancel/.test(message)) return "cancelled";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/size limit|too large|exceeded/.test(message)) return "too_large";
  if (/scope|tenant/.test(message)) return "scope_mismatch";
  return "snapshot_unavailable";
}
