import "server-only";

import { createHmac } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import {
  APP_BUILDER_APP_PORT,
  APP_BUILDER_PREVIEW_PORT,
  APP_BUILDER_ROOT,
  boundedBuilderOutput,
  builderFileSha256,
  safeBuilderRelativePath,
  type AppBuilderCommandKind,
  type AppBuilderFile,
  type AppBuilderTreeEntry,
} from "@/lib/app-builder/contracts";
import { appBuilderStarterTemplate } from "@/lib/app-builder/templates";

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 8 * 60 * 1_000;
const CHECKPOINT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1_000;

const commandTable: Record<Exclude<AppBuilderCommandKind, "start_preview">, readonly [string, readonly string[]]> = {
  lint: ["npm", ["run", "lint"]],
  typecheck: ["npm", ["run", "typecheck"]],
  test: ["npm", ["test"]],
  build: ["npm", ["run", "build"]],
};

const previewProxySource = `import http from "node:http";
const token = process.env.ASAEL_PREVIEW_TOKEN;
if (!token) throw new Error("Preview token is required");
const cookieName = "asael_preview";
function authorized(reqUrl, cookie) {
  const url = new URL(reqUrl || "/", "http://preview.local");
  return url.searchParams.get(cookieName) === token || (cookie || "").split(/;\\s*/).includes(cookieName + "=" + token);
}
const server = http.createServer((request, response) => {
  if (!authorized(request.url, request.headers.cookie)) {
    response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("This Asael preview link is private or expired.");
    return;
  }
  const incoming = new URL(request.url || "/", "http://preview.local");
  if (incoming.searchParams.get(cookieName) === token) {
    incoming.searchParams.delete(cookieName);
    response.setHeader("set-cookie", cookieName + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1800");
  }
  const upstream = http.request({ hostname: "127.0.0.1", port: ${APP_BUILDER_APP_PORT}, path: incoming.pathname + incoming.search, method: request.method, headers: { ...request.headers, host: "127.0.0.1:${APP_BUILDER_APP_PORT}" } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Preview is starting. Try refresh in a moment."); });
  request.pipe(upstream);
});
server.listen(${APP_BUILDER_PREVIEW_PORT}, "0.0.0.0");
`;

export async function createBuilderSandbox(input: {
  sandboxName: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
}) {
  const sandbox = await Sandbox.create({
    name: input.sandboxName,
    image: "vercel/sandbox/node:24",
    ports: [APP_BUILDER_PREVIEW_PORT],
    timeout: SANDBOX_TIMEOUT_MS,
    resources: { vcpus: 2 },
    persistent: true,
    snapshotExpiration: CHECKPOINT_EXPIRATION_MS,
    keepLastSnapshots: {
      count: 10,
      expiration: CHECKPOINT_EXPIRATION_MS,
      deleteEvicted: false,
    },
    networkPolicy: { allow: ["registry.npmjs.org", "*.npmjs.org"] },
    env: { NEXT_TELEMETRY_DISABLED: "1", CI: "1" },
    tags: { product: "asael-builder", session: input.sessionId.slice(-20) },
  });
  await sandbox.fs.mkdir(APP_BUILDER_ROOT, { recursive: true });
  await sandbox.writeFiles([
    ...appBuilderStarterTemplate.files.map((file) => ({
      path: `${APP_BUILDER_ROOT}/${file.path}`,
      content: file.content,
    })),
    { path: "/vercel/sandbox/asael-preview-proxy.mjs", content: previewProxySource, mode: 0o500 },
  ]);
  const install = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const [stdout, stderr] = await Promise.all([install.stdout(), install.stderr()]);
  if (install.exitCode !== 0) {
    await sandbox.stop().catch(() => undefined);
    throw new Error(`Starter dependency installation failed. ${boundedBuilderOutput(stderr || stdout, 2_000)}`);
  }
  await startBuilderPreview(sandbox, previewToken(input));
  return {
    install: commandResult(install.exitCode, stdout, stderr, install.durationMs),
    previewUrl: previewUrl(sandbox, previewToken(input)),
  };
}

export async function getBuilderPreviewUrl(input: {
  sandboxName: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
}) {
  const sandbox = await Sandbox.get({ name: input.sandboxName });
  return previewUrl(sandbox, previewToken(input));
}

export async function listBuilderFiles(sandboxName: string): Promise<AppBuilderTreeEntry[]> {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const result = await sandbox.runCommand({
    cmd: "find",
    args: [".", "-maxdepth", "8", "-type", "f", "-not", "-path", "./node_modules/*", "-not", "-path", "./.next/*", "-printf", "%P\\t%s\\n"],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) throw new Error("The builder file index could not be read.");
  const rows = (await result.stdout()).split("\n").filter(Boolean).slice(0, 500).map((line) => {
    const [relativePath, rawSize] = line.split("\t");
    return { path: safeBuilderRelativePath(relativePath || ""), kind: "file" as const, size: Number(rawSize) || 0 };
  });
  const directories = new Set<string>();
  for (const row of rows) {
    const pieces = row.path.split("/");
    for (let index = 1; index < pieces.length; index += 1) directories.add(pieces.slice(0, index).join("/"));
  }
  return [
    ...[...directories].map((relativePath) => ({ path: relativePath, kind: "directory" as const })),
    ...rows,
  ].sort((left, right) => left.path.localeCompare(right.path));
}

export async function readBuilderFile(sandboxName: string, requestedPath: string): Promise<AppBuilderFile> {
  const relativePath = safeBuilderRelativePath(requestedPath);
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const buffer = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  if (!buffer) throw new Error("Builder file was not found.");
  if (buffer.byteLength > 500_000) throw new Error("Builder file is too large to inspect in this workspace.");
  const content = buffer.toString("utf8");
  return { path: relativePath, content, sha256: builderFileSha256(buffer), size: buffer.byteLength };
}

export async function updateBuilderFile(input: {
  sandboxName: string;
  path: string;
  expectedSha256: string | null;
  content: string;
}) {
  const relativePath = safeBuilderRelativePath(input.path);
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const current = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  const currentSha256 = current ? builderFileSha256(current) : null;
  if (currentSha256 !== input.expectedSha256) {
    throw new Error("Builder file changed after it was inspected. Read it again before applying an update.");
  }
  const parent = relativePath.split("/").slice(0, -1).join("/");
  if (parent) await sandbox.runCommand({ cmd: "mkdir", args: ["-p", `${APP_BUILDER_ROOT}/${parent}`], timeoutMs: 10_000 });
  await sandbox.writeFiles([{ path: `${APP_BUILDER_ROOT}/${relativePath}`, content: input.content }]);
  return { path: relativePath, previousSha256: currentSha256, sha256: builderFileSha256(input.content), size: Buffer.byteLength(input.content) };
}

export async function runBuilderCommand(input: {
  sandboxName: string;
  command: AppBuilderCommandKind;
  previewIdentity?: { tenantId: string; ownerActorId: string; projectId: string; sessionId: string };
}) {
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  if (input.command === "start_preview") {
    if (!input.previewIdentity) throw new Error("Preview identity is required.");
    await startBuilderPreview(sandbox, previewToken(input.previewIdentity));
    return { command: input.command, exitCode: 0, stdout: "Preview restarted.", stderr: "", durationMs: 0 };
  }
  const [cmd, args] = commandTable[input.command];
  const result = await sandbox.runCommand({ cmd, args: [...args], cwd: APP_BUILDER_ROOT, timeoutMs: COMMAND_TIMEOUT_MS });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  return { command: input.command, ...commandResult(result.exitCode, stdout, stderr, result.durationMs) };
}

export async function stopBuilderSandbox(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName });
  await sandbox.stop();
}

export async function createBuilderSandboxCheckpoint(input: {
  sandboxName: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
}) {
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const workspace = await builderWorkspaceManifest(sandbox);
  const snapshot = await sandbox.snapshot({ expiration: CHECKPOINT_EXPIRATION_MS });
  const resumed = await Sandbox.get({ name: input.sandboxName, resume: true });
  await startBuilderPreview(resumed, previewToken(input));
  return {
    providerSnapshotId: snapshot.snapshotId,
    workspaceSha256: workspace.sha256,
    fileCount: workspace.fileCount,
    snapshotBytes: Math.max(0, snapshot.sizeBytes || 0),
    expiresAt: snapshot.expiresAt?.toISOString(),
    previewUrl: previewUrl(resumed, previewToken(input)),
  };
}

export async function restoreBuilderSandboxCheckpoint(input: {
  sandboxName: string;
  providerSnapshotId: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
}) {
  const sandbox = await Sandbox.get({ name: input.sandboxName });
  await sandbox.stop().catch(() => undefined);
  await sandbox.update({ currentSnapshotId: input.providerSnapshotId });
  const resumed = await Sandbox.get({ name: input.sandboxName, resume: true });
  await startBuilderPreview(resumed, previewToken(input));
  const workspace = await builderWorkspaceManifest(resumed);
  return {
    workspaceSha256: workspace.sha256,
    fileCount: workspace.fileCount,
    previewUrl: previewUrl(resumed, previewToken(input)),
  };
}

async function startBuilderPreview(sandbox: Sandbox, token: string) {
  await sandbox.runCommand({ cmd: "pkill", args: ["-f", `next dev.*${APP_BUILDER_APP_PORT}`], timeoutMs: 10_000 }).catch(() => undefined);
  await sandbox.runCommand({ cmd: "pkill", args: ["-f", "asael-preview-proxy.mjs"], timeoutMs: 10_000 }).catch(() => undefined);
  await sandbox.runCommand({
    cmd: "npm",
    args: ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(APP_BUILDER_APP_PORT)],
    cwd: APP_BUILDER_ROOT,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    detached: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  await sandbox.runCommand({
    cmd: "node",
    args: ["/vercel/sandbox/asael-preview-proxy.mjs"],
    env: { ASAEL_PREVIEW_TOKEN: token },
    detached: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
}

function previewToken(input: { tenantId: string; ownerActorId: string; projectId: string; sessionId: string }) {
  const secret = process.env.OMNIAGENT_APP_BUILDER_PREVIEW_SECRET || process.env.OMNIAGENT_CREDENTIAL_KEYRING;
  if (!secret || secret.length < 32) throw new Error("App Builder preview signing is not configured.");
  return createHmac("sha256", secret).update(`asael-app-builder-preview:1:${input.tenantId}:${input.ownerActorId}:${input.projectId}:${input.sessionId}`).digest("base64url");
}

function previewUrl(sandbox: Sandbox, token: string) {
  const url = new URL(sandbox.domain(APP_BUILDER_PREVIEW_PORT));
  url.searchParams.set("asael_preview", token);
  return url.toString();
}

async function builderWorkspaceManifest(sandbox: Sandbox) {
  const result = await sandbox.runCommand({
    cmd: "find",
    args: [
      ".", "-maxdepth", "8", "-type", "f",
      "-not", "-path", "./node_modules/*",
      "-not", "-path", "./.next/*",
      "-exec", "sha256sum", "{}", "+",
    ],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("The builder workspace could not be checkpointed.");
  const rows = (await result.stdout()).split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\.\/(.+)$/);
    if (!match) throw new Error("The builder workspace manifest was malformed.");
    return { sha256: match[1], path: safeBuilderRelativePath(match[2]) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!rows.length || rows.length > 500) throw new Error("The builder workspace manifest is outside its file budget.");
  return {
    fileCount: rows.length,
    sha256: builderFileSha256(rows.map((row) => `${row.path}\u0000${row.sha256}`).join("\n")),
  };
}

export async function getBuilderWorkspaceManifest(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  return builderWorkspaceManifest(sandbox);
}

function commandResult(exitCode: number, stdout: string, stderr: string, durationMs?: number) {
  return { exitCode, stdout: boundedBuilderOutput(stdout), stderr: boundedBuilderOutput(stderr), durationMs: durationMs || 0 };
}
