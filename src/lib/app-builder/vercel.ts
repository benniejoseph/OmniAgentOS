import "server-only";

import { createHash, createHmac } from "node:crypto";
import type {
  AppBuilderDeployment,
  AppBuilderFile,
  AppBuilderVercelStatus,
} from "@/lib/app-builder/contracts";

const VERCEL_API = "https://api.vercel.com";
const REQUEST_DEADLINE_MS = 30_000;
const ROUTE_DEADLINE_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_LOG_BYTES = 1_000_000;
const MAX_DEPLOYMENT_FILES = 500;
const MAX_DEPLOYMENT_BYTES = 8_000_000;

type VercelConfig = Readonly<{ token: string; teamId: string }>;

export type BuilderVercelDeployment = Readonly<{
  projectId: string;
  deploymentId: string;
  state: string;
  url: string;
}>;

export function getBuilderVercelStatus(): AppBuilderVercelStatus {
  const missing = [] as string[];
  if (!process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN?.trim()) missing.push("Vercel access token");
  if (!process.env.OMNIAGENT_VERCEL_TEAM_ID?.trim()) missing.push("Vercel team ID");
  return { configured: missing.length === 0, missing };
}

export function builderVercelProjectName(tenantId: string, actorId: string, projectId: string) {
  const suffix = createHash("sha256")
    .update(`app-builder-vercel-project:1:${tenantId}:${actorId}:${projectId}`)
    .digest("hex")
    .slice(0, 16);
  return `asael-app-${suffix}`;
}

export async function createBuilderVercelPreview(input: {
  deploymentReceiptId: string;
  projectName: string;
  checkpointId: string;
  workspaceSha256: string;
  commitSha?: string;
  files: readonly AppBuilderFile[];
}): Promise<BuilderVercelDeployment> {
  assertDeploymentFiles(input.files);
  if (!/^asael-app-[a-f0-9]{16}$/.test(input.projectName)) {
    throw new Error("The App Builder Vercel project name is invalid.");
  }
  const config = vercelConfig();
  const prepared = input.files.map((file) => {
    const bytes = Buffer.from(file.content, "utf8");
    return {
      file: file.path,
      size: bytes.byteLength,
      mode: 0o100644,
      sha: createHash("sha1").update(bytes).digest("hex"),
      bytes,
    };
  });
  const payload = {
    name: input.projectName,
    version: 2,
    files: prepared.map(({ file, size, mode, sha }) => ({ file, size, mode, sha })),
    projectSettings: { framework: "nextjs" },
    meta: {
      asaelDeploymentId: input.deploymentReceiptId,
      asaelCheckpointId: input.checkpointId,
      asaelWorkspaceSha256: input.workspaceSha256,
      ...(input.commitSha ? { asaelCommitSha: input.commitSha } : {}),
    },
  };

  let response = await vercelJsonRequest("/v13/deployments", {
    config,
    method: "POST",
    body: payload,
    idempotencyKey: input.deploymentReceiptId,
  });
  if (!response.ok) {
    const error = providerError(response.body);
    if (error.code !== "missing_files" || !Array.isArray(error.missing)) {
      throw vercelRejected(response.status, error.message);
    }
    const bySha = new Map(prepared.map((file) => [file.sha, file]));
    const missing = [...new Set(error.missing.filter((sha): sha is string =>
      typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    ))];
    if (!missing.length || missing.some((sha) => !bySha.has(sha))) {
      throw new Error("Vercel requested a file outside the exact reviewed deployment manifest.");
    }
    await mapWithConcurrency(missing, 6, async (sha) => {
      const file = bySha.get(sha)!;
      await uploadVercelFile(config, sha, file.bytes);
    });
    response = await vercelJsonRequest("/v13/deployments", {
      config,
      method: "POST",
      body: payload,
      idempotencyKey: input.deploymentReceiptId,
    });
  }
  if (!response.ok) {
    throw vercelRejected(response.status, providerError(response.body).message);
  }
  return deploymentFromProvider(response.body);
}

export async function getBuilderVercelDeployment(deploymentId: string) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error("The Vercel deployment ID is invalid.");
  const response = await vercelJsonRequest(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
    config: vercelConfig(),
    method: "GET",
  });
  if (!response.ok) throw vercelRejected(response.status, providerError(response.body).message);
  return deploymentFromProvider(response.body);
}

export async function ensureBuilderVercelProtectionBypass(projectId: string) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("The Vercel project ID is invalid.");
  const config = vercelConfig();
  const secret = builderVercelProtectionBypassSecret(projectId);
  const path = `/v1/projects/${encodeURIComponent(projectId)}/protection-bypass`;
  let response = await vercelJsonRequest(path, {
    config,
    method: "PATCH",
    body: { generate: { secret, note: "Asael App Builder verification" } },
  });
  if (!response.ok && response.status === 409) {
    response = await vercelJsonRequest(path, {
      config,
      method: "PATCH",
      body: { update: { secret, note: "Asael App Builder verification" } },
    });
  }
  if (!response.ok) {
    throw vercelRejected(response.status, "preview verification access could not be configured");
  }
  return secret;
}

export async function getBuilderVercelProductionDeployment(projectId: string) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("The Vercel project ID is invalid.");
  const query = new URLSearchParams({ projectId, target: "production", state: "READY", limit: "1" });
  const response = await vercelJsonRequest(`/v7/deployments?${query}`, {
    config: vercelConfig(),
    method: "GET",
  });
  if (!response.ok) throw vercelRejected(response.status, providerError(response.body).message);
  const deployments = Array.isArray(response.body.deployments) ? response.body.deployments : [];
  const item = deployments[0];
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const deploymentId = typeof record.uid === "string" ? record.uid : typeof record.id === "string" ? record.id : "";
  const rawUrl = typeof record.url === "string" ? record.url : "";
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId) || !rawUrl) return undefined;
  return {
    deploymentId,
    url: assertVercelPreviewUrl(rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`).toString(),
  };
}

export async function createBuilderVercelProduction(input: {
  releaseReceiptId: string;
  projectName: string;
  previewDeploymentId: string;
  workspaceSha256: string;
}) {
  if (!/^app_build_release_[a-f0-9]{48}$/.test(input.releaseReceiptId)) throw new Error("The production release receipt is invalid.");
  if (!/^asael-app-[a-f0-9]{16}$/.test(input.projectName)) throw new Error("The App Builder Vercel project name is invalid.");
  if (!/^dpl_[A-Za-z0-9]+$/.test(input.previewDeploymentId)) throw new Error("The preview deployment ID is invalid.");
  const response = await vercelJsonRequest("/v13/deployments", {
    config: vercelConfig(),
    method: "POST",
    idempotencyKey: input.releaseReceiptId,
    body: {
      deploymentId: input.previewDeploymentId,
      name: input.projectName,
      target: "production",
      meta: {
        action: "promote",
        asaelReleaseId: input.releaseReceiptId,
        asaelWorkspaceSha256: input.workspaceSha256,
      },
    },
  });
  if (!response.ok) throw vercelRejected(response.status, providerError(response.body).message);
  return deploymentFromProvider(response.body);
}

export async function getBuilderVercelLogEvidence(deploymentId: string): Promise<AppBuilderDeployment["logs"]> {
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) return { status: "unavailable", eventCount: 0 };
  try {
    const config = vercelConfig();
    const query = new URLSearchParams({
      direction: "backward",
      follow: "",
      format: "lines",
      limit: "200",
      teamId: config.teamId,
    });
    const response = await vercelRawRequest(`/v3/now/deployments/${encodeURIComponent(deploymentId)}/events?${query}`, {
      config,
      method: "GET",
      limit: MAX_LOG_BYTES,
    });
    if (!response.ok) return { status: "unavailable", eventCount: 0 };
    const text = response.bytes.toString("utf8");
    const eventCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return {
      status: "captured",
      sha256: createHash("sha256").update(response.bytes).digest("hex"),
      eventCount: Math.min(eventCount, 10_000),
    };
  } catch {
    return { status: "unavailable", eventCount: 0 };
  }
}

export function discoverBuilderSmokeRoutes(files: readonly Pick<AppBuilderFile, "path">[]) {
  const routes = new Set<string>();
  for (const file of files) {
    const match = file.path.match(/^(?:src\/)?app\/(.*\/)?page\.(?:[cm]?[jt]sx?)$/);
    if (!match) continue;
    const segments = (match[1] || "").split("/").filter(Boolean);
    if (segments.some((segment) => segment.startsWith("[") || segment.startsWith("@") || segment.startsWith("_"))) continue;
    const publicSegments = segments.filter((segment) => !/^\(.*\)$/.test(segment));
    routes.add(`/${publicSegments.join("/")}`.replace(/\/$/, "") || "/");
  }
  if (!routes.size) routes.add("/");
  return [...routes].sort((left, right) => left.localeCompare(right)).slice(0, 20);
}

export async function runBuilderVercelRouteSmokes(
  deploymentUrl: string,
  routes: readonly string[],
  options: { protectionBypassSecret?: string } = {},
): Promise<AppBuilderDeployment["routeEvidence"]> {
  const base = assertVercelPreviewUrl(deploymentUrl);
  const evidence: AppBuilderDeployment["routeEvidence"]["routes"][number][] = [];
  for (const route of routes.slice(0, 20)) {
    const safeRoute = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/.test(route) ? route : "/";
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_DEADLINE_MS);
    try {
      const response = await fetch(new URL(safeRoute, base), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: previewBypassHeaders(options.protectionBypassSecret),
      });
      const bytes = await readBoundedBody(response, 1_000_000);
      evidence.push({
        path: safeRoute,
        status: response.ok ? "passed" : "failed",
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      evidence.push({
        path: safeRoute,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: `route_${createHash("sha256").update(error instanceof Error ? error.message : "unknown").digest("hex").slice(0, 12)}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    status: evidence.length > 0 && evidence.every((route) => route.status === "passed") ? "passed" : "failed",
    routes: evidence,
  };
}

function assertDeploymentFiles(files: readonly AppBuilderFile[]) {
  if (files.length < 1 || files.length > MAX_DEPLOYMENT_FILES) {
    throw new Error(`Vercel preview deployment requires 1-${MAX_DEPLOYMENT_FILES} reviewed files.`);
  }
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  if (bytes > MAX_DEPLOYMENT_BYTES) throw new Error("The reviewed application exceeds the 8 MB preview deployment limit.");
}

function vercelConfig(): VercelConfig {
  const status = getBuilderVercelStatus();
  if (!status.configured) throw new Error(`Vercel preview setup is incomplete: ${status.missing.join(", ")}.`);
  const token = process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN!.trim();
  const teamId = process.env.OMNIAGENT_VERCEL_TEAM_ID!.trim();
  if (token.length < 20 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("The configured Vercel access token is invalid.");
  if (!/^[A-Za-z0-9_]{3,128}$/.test(teamId)) throw new Error("The configured Vercel team ID is invalid.");
  return { token, teamId };
}

async function uploadVercelFile(config: VercelConfig, sha: string, bytes: Buffer) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
  try {
    const response = await fetch(`${VERCEL_API}/v2/files?teamId=${encodeURIComponent(config.teamId)}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "user-agent": "asael-app-builder",
        "x-now-digest": sha,
        "x-now-size": String(bytes.byteLength),
      },
      body: new Uint8Array(bytes).buffer,
    });
    if (!response.ok) throw vercelRejected(response.status, "file upload failed");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Vercel did not accept the reviewed file before the upload deadline.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function vercelJsonRequest(
  path: string,
  options: { config: VercelConfig; method: "GET" | "POST" | "PATCH"; body?: unknown; idempotencyKey?: string },
) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await vercelRawRequest(`${path}${separator}teamId=${encodeURIComponent(options.config.teamId)}`, {
    config: options.config,
    method: options.method,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    idempotencyKey: options.idempotencyKey,
    limit: MAX_RESPONSE_BYTES,
  });
  let body: Record<string, unknown> = {};
  try {
    body = response.bytes.length ? JSON.parse(response.bytes.toString("utf8")) as Record<string, unknown> : {};
  } catch {
    throw new Error("Vercel returned an invalid deployment response.");
  }
  return { ok: response.ok, status: response.status, body };
}

async function vercelRawRequest(
  path: string,
  options: { config: VercelConfig; method: "GET" | "POST" | "PATCH"; body?: string; idempotencyKey?: string; limit: number },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
  try {
    const response = await fetch(`${VERCEL_API}${path}`, {
      method: options.method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.config.token}`,
        "content-type": options.body === undefined ? "application/json" : "application/json",
        "user-agent": "asael-app-builder",
        ...(options.idempotencyKey ? { "x-vercel-idempotency-key": options.idempotencyKey } : {}),
      },
      body: options.body,
    });
    const bytes = await readBoundedBody(response, options.limit);
    return { ok: response.ok, status: response.status, bytes };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Vercel did not respond before the preview deployment deadline.");
    if (error instanceof Error && error.message.startsWith("Vercel ")) throw error;
    throw new Error("Vercel could not be reached for this governed preview operation.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("Vercel returned an oversized response.");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Vercel returned an oversized response.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function deploymentFromProvider(body: Record<string, unknown>): BuilderVercelDeployment {
  const deploymentId = typeof body.id === "string" ? body.id : typeof body.deploymentId === "string" ? body.deploymentId : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : typeof body.project === "string" ? body.project : "";
  const state = typeof body.readyState === "string" ? body.readyState : typeof body.state === "string" ? body.state : "QUEUED";
  const rawUrl = typeof body.url === "string" ? body.url : "";
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId) || !/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error("Vercel did not return a valid project and deployment identity.");
  }
  const url = assertVercelPreviewUrl(rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`).toString();
  return { projectId, deploymentId, state: state.slice(0, 40), url };
}

function assertVercelPreviewUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port || url.username || url.password || url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)
  ) {
    throw new Error("Vercel returned an invalid preview URL.");
  }
  url.pathname = "/";
  url.search = "";
  return url;
}

function providerError(body: Record<string, unknown>) {
  const source = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : body;
  return {
    code: typeof source.code === "string" ? source.code : "unknown",
    message: typeof source.message === "string" ? source.message.slice(0, 240) : "request failed",
    missing: source.missing,
  };
}

function vercelRejected(status: number, message: string) {
  return new Error(`Vercel rejected the deployment operation (${status}: ${message}).`);
}

function builderVercelProtectionBypassSecret(projectId: string) {
  const configured = process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9]{32}$/.test(configured)) {
      throw new Error("The configured Vercel protection bypass token is invalid.");
    }
    return configured;
  }
  const signingSecret = process.env.OMNIAGENT_APP_BUILDER_PREVIEW_SECRET?.trim()
    || process.env.OMNIAGENT_CREDENTIAL_KEYRING?.trim();
  if (!signingSecret) {
    throw new Error("Vercel preview verification requires the App Builder preview secret or credential keyring.");
  }
  return createHmac("sha256", signingSecret)
    .update(`asael-app-builder-vercel-bypass:1:${projectId}`)
    .digest("hex")
    .slice(0, 32);
}

function previewBypassHeaders(explicitToken?: string) {
  const token = explicitToken?.trim() || process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN?.trim();
  return token ? { "x-vercel-protection-bypass": token } : undefined;
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, () => worker()));
}
