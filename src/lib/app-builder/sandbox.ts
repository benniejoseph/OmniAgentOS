import "server-only";

import { createHmac } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { getAppBaseUrl } from "@/lib/config";
import {
  APP_BUILDER_APP_PORT,
  APP_BUILDER_PREVIEW_PORT,
  APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION,
  APP_BUILDER_ROOT,
  boundedBuilderOutput,
  builderFileSha256,
  safeBuilderRelativePath,
  sliceAppBuilderFileContent,
  type AppBuilderCommandKind,
  type AppBuilderDeliveryChange,
  type AppBuilderFile,
  type AppBuilderRepositoryWorkspace,
  type AppBuilderTreeEntry,
} from "@/lib/app-builder/contracts";
import { appBuilderStarterTemplate } from "@/lib/app-builder/templates";

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 8 * 60 * 1_000;
const CHECKPOINT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WORKSPACE_FILES = 10_000;
const REPOSITORY_ARCHIVE_PATH = "/vercel/sandbox/asael-repository-source.tar.gz";
const REPOSITORY_BASELINE_PATH = "/vercel/sandbox/asael-repository-baseline.json";

type RepositoryBaseline = AppBuilderRepositoryWorkspace & Readonly<{
  entries: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
}>;

const commandTable: Record<Exclude<AppBuilderCommandKind, "start_preview">, readonly [string, readonly string[]]> = {
  lint: ["npm", ["run", "lint"]],
  typecheck: ["npm", ["run", "typecheck"]],
  test: ["npm", ["test"]],
  build: ["npm", ["run", "build"]],
};

const previewProxySource = `import http from "node:http";
const token = process.env.ASAEL_PREVIEW_TOKEN;
if (!token) throw new Error("Preview token is required");
const parentOrigin = process.env.ASAEL_PREVIEW_PARENT_ORIGIN;
if (!parentOrigin) throw new Error("Preview parent origin is required");
const parsedParentOrigin = new URL(parentOrigin);
if (parsedParentOrigin.origin !== parentOrigin || (parsedParentOrigin.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(parsedParentOrigin.hostname))) {
  throw new Error("Preview parent origin is invalid");
}
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
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders["x-frame-options"];
    const upstreamCsp = Array.isArray(responseHeaders["content-security-policy"])
      ? responseHeaders["content-security-policy"].join("; ")
      : String(responseHeaders["content-security-policy"] || "");
    const cspDirectives = upstreamCsp.split(";").map((part) => part.trim()).filter((part) => part && !part.toLowerCase().startsWith("frame-ancestors "));
    cspDirectives.push("frame-ancestors " + parentOrigin);
    responseHeaders["content-security-policy"] = cspDirectives.join("; ");
    responseHeaders["referrer-policy"] = "no-referrer";
    responseHeaders["x-content-type-options"] = "nosniff";
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
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
    args: [".", "-maxdepth", "12", "-type", "f", ...workspaceFindExclusions(), "-printf", "%P\\t%s\\n"],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) throw new Error("The builder file index could not be read.");
  const rows = (await result.stdout()).split("\n").filter(Boolean).flatMap((line): AppBuilderTreeEntry[] => {
    const [relativePath, rawSize] = line.split("\t");
    const safePath = safeWorkspacePath(relativePath || "");
    return safePath ? [{ path: safePath, kind: "file", size: Number(rawSize) || 0 }] : [];
  }).slice(0, 500);
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

export async function searchBuilderFiles(input: { sandboxName: string; query: string }) {
  const query = input.query.trim();
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const names = await sandbox.runCommand({
    cmd: "find",
    args: [".", "-maxdepth", "12", "-type", "f", ...workspaceFindExclusions(), "-printf", "%P\\t%s\\n"],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 20_000,
  });
  if (names.exitCode !== 0) throw new Error("The builder filename index could not be searched.");
  const content = await sandbox.runCommand({
    cmd: "grep",
    args: [
      "-RIlF", "--max-count=1", "--exclude-dir=node_modules", "--exclude-dir=.next",
      "--exclude=*.tsbuildinfo", "--", query, ".",
    ],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 30_000,
  });
  if (content.exitCode !== 0 && content.exitCode !== 1) {
    throw new Error("The builder source index could not be searched.");
  }
  const lowered = query.toLocaleLowerCase();
  const indexedFiles = (await names.stdout()).split("\n").flatMap((line) => {
    const [candidate, rawSize] = line.split("\t");
    const path = safeWorkspacePath(candidate || "");
    return path ? [{ path, size: Number(rawSize) || 0 }] : [];
  });
  const sizeByPath = new Map(indexedFiles.map((entry) => [entry.path, entry.size]));
  const matchedNames = indexedFiles
    .filter((entry) => entry.path.toLocaleLowerCase().includes(lowered))
    .map((entry) => entry.path);
  const matchedContent = (await content.stdout()).split("\n")
    .map((candidate) => candidate.startsWith("./") ? candidate.slice(2) : candidate);
  const paths = [...new Set([...matchedNames, ...matchedContent])]
    .map(safeWorkspacePath)
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => sizeByPath.has(candidate))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100);
  return paths.map((path) => ({ path, kind: "file" as const, size: sizeByPath.get(path)! }));
}

export async function readBuilderFile(
  sandboxName: string,
  requestedPath: string,
  range?: Readonly<{ startLine: number; lineCount: number }>,
): Promise<AppBuilderFile> {
  const relativePath = safeBuilderRelativePath(requestedPath);
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const buffer = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  if (!buffer) throw new Error("Builder file was not found.");
  if (buffer.byteLength > 500_000) throw new Error("Builder file is too large to inspect in this workspace.");
  const content = buffer.toString("utf8");
  return {
    path: relativePath,
    ...sliceAppBuilderFileContent(content, range),
    sha256: builderFileSha256(buffer),
    size: buffer.byteLength,
  };
}

export async function readBuilderWorkspaceFiles(sandboxName: string): Promise<AppBuilderFile[]> {
  const entries = (await listBuilderFiles(sandboxName)).filter(
    (entry): entry is AppBuilderTreeEntry & { kind: "file" } => entry.kind === "file",
  );
  const files = await mapWithConcurrency(entries, 8, (entry) =>
    readBuilderFile(sandboxName, entry.path),
  );
  const byteCount = files.reduce((total, file) => total + file.size, 0);
  if (byteCount > 8_000_000) {
    throw new Error("The builder workspace exceeds the reviewed 8 MB delivery boundary.");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
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

export async function deleteBuilderFile(input: {
  sandboxName: string;
  path: string;
  expectedSha256: string;
}) {
  const relativePath = safeBuilderRelativePath(input.path);
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const current = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  if (!current) throw new Error("Builder file was not found.");
  const currentSha256 = builderFileSha256(current);
  if (currentSha256 !== input.expectedSha256) {
    throw new Error("Builder file changed after it was inspected. Read it again before deleting it.");
  }
  const removed = await sandbox.runCommand({
    cmd: "rm",
    args: ["--", `${APP_BUILDER_ROOT}/${relativePath}`],
    timeoutMs: 10_000,
  });
  if (removed.exitCode !== 0) throw new Error("Builder file could not be deleted.");
  return { path: relativePath, previousSha256: currentSha256 };
}

export async function checkoutBuilderRepositoryArchive(input: {
  sandboxName: string;
  repositoryId: string;
  repositoryFullName: string;
  baseSha: string;
  archiveSha256: string;
  archive: Uint8Array;
  previewIdentity: { tenantId: string; ownerActorId: string; projectId: string; sessionId: string };
}) {
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  await stopBuilderPreviewProcesses(sandbox);
  await sandbox.writeFiles([{ path: REPOSITORY_ARCHIVE_PATH, content: input.archive, mode: 0o400 }]);
  try {
    await validateRepositoryArchive(sandbox);
    const removed = await sandbox.runCommand({
      cmd: "rm",
      args: ["-rf", "--", APP_BUILDER_ROOT],
      timeoutMs: 30_000,
    });
    if (removed.exitCode !== 0) throw new Error("The previous builder workspace could not be replaced safely.");
    await sandbox.fs.mkdir(APP_BUILDER_ROOT, { recursive: true });
    const extracted = await sandbox.runCommand({
      cmd: "tar",
      args: [
        "-xzf", REPOSITORY_ARCHIVE_PATH, "--strip-components=1", "--no-same-owner",
        "--no-same-permissions", "--directory", APP_BUILDER_ROOT,
      ],
      timeoutMs: 60_000,
    });
    if (extracted.exitCode !== 0) throw new Error("The reviewed GitHub archive could not be extracted.");
    const packageJson = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/package.json` });
    if (!packageJson) throw new Error("Repository checkout currently requires a Node application with package.json at its root.");
    const baselineRows = await builderWorkspaceRows(sandbox);
    const workspaceSha256 = workspaceRowsSha256(baselineRows);
    const importedAt = new Date().toISOString();
    const baseline: RepositoryBaseline = {
      contractVersion: APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      baseSha: input.baseSha,
      archiveSha256: input.archiveSha256,
      workspaceSha256,
      fileCount: baselineRows.length,
      importedAt,
      entries: baselineRows,
    };
    await sandbox.writeFiles([{
      path: REPOSITORY_BASELINE_PATH,
      content: JSON.stringify(baseline),
      mode: 0o400,
    }]);
    const lockfile = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/package-lock.json` });
    const install = await sandbox.runCommand({
      cmd: "npm",
      args: [lockfile ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"],
      cwd: APP_BUILDER_ROOT,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([install.stdout(), install.stderr()]);
    if (install.exitCode !== 0) {
      throw new Error(`Repository dependencies could not be installed. ${boundedBuilderOutput(stderr || stdout, 2_000)}`);
    }
    await startBuilderPreview(sandbox, previewToken(input.previewIdentity));
    return {
      workspace: publicRepositoryWorkspace(baseline),
      install: commandResult(install.exitCode, stdout, stderr, install.durationMs),
      previewUrl: previewUrl(sandbox, previewToken(input.previewIdentity)),
    };
  } finally {
    await sandbox.runCommand({ cmd: "rm", args: ["-f", "--", REPOSITORY_ARCHIVE_PATH], timeoutMs: 10_000 }).catch(() => undefined);
  }
}

export async function getBuilderRepositoryWorkspace(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const baseline = await readRepositoryBaseline(sandbox);
  return baseline ? publicRepositoryWorkspace(baseline) : null;
}

export async function readBuilderRepositoryChanges(input: {
  sandboxName: string;
  repositoryId: string;
  baseSha: string;
}): Promise<AppBuilderDeliveryChange[]> {
  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const baseline = await readRepositoryBaseline(sandbox);
  if (!baseline || baseline.repositoryId !== input.repositoryId || baseline.baseSha !== input.baseSha) {
    throw new Error("The builder workspace is not checked out from this exact repository revision.");
  }
  const currentRows = await builderWorkspaceRows(sandbox);
  const current = new Map(currentRows.map((row) => [row.path, row.sha256]));
  const previous = new Map(baseline.entries.map((row) => [row.path, row.sha256]));
  const changes: AppBuilderDeliveryChange[] = [];
  for (const row of currentRows) {
    if (previous.get(row.path) !== row.sha256) {
      changes.push({ kind: "upsert", file: await readBuilderFile(input.sandboxName, row.path) });
    }
  }
  for (const row of baseline.entries) {
    if (!current.has(row.path)) changes.push({ kind: "delete", path: row.path, previousSha256: row.sha256 });
  }
  if (changes.length > 500) throw new Error("Repository delivery exceeds the 500-change review boundary.");
  return changes.sort((left, right) => changePath(left).localeCompare(changePath(right)));
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
  await sandbox.writeFiles([
    {
      path: "/vercel/sandbox/asael-preview-proxy.mjs",
      content: previewProxySource,
      mode: 0o500,
    },
  ]);
  await stopBuilderPreviewProcesses(sandbox);
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
    env: {
      ASAEL_PREVIEW_TOKEN: token,
      ASAEL_PREVIEW_PARENT_ORIGIN: builderPreviewParentOrigin(),
    },
    detached: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
}

function builderPreviewParentOrigin() {
  const url = new URL(getAppBaseUrl());
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("App Builder preview parent origin must be HTTPS or loopback HTTP.");
  }
  return url.origin;
}

async function stopBuilderPreviewProcesses(sandbox: Sandbox) {
  await sandbox.runCommand({ cmd: "pkill", args: ["-f", `next dev.*${APP_BUILDER_APP_PORT}`], timeoutMs: 10_000 }).catch(() => undefined);
  await sandbox.runCommand({ cmd: "pkill", args: ["-f", "asael-preview-proxy.mjs"], timeoutMs: 10_000 }).catch(() => undefined);
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
  const rows = await builderWorkspaceRows(sandbox);
  return { fileCount: rows.length, sha256: workspaceRowsSha256(rows) };
}

async function builderWorkspaceRows(sandbox: Sandbox) {
  const result = await sandbox.runCommand({
    cmd: "find",
    args: [
      ".", "-maxdepth", "12", "-type", "f",
      ...workspaceFindExclusions(),
      "-exec", "sha256sum", "{}", "+",
    ],
    cwd: APP_BUILDER_ROOT,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("The builder workspace could not be checkpointed.");
  const rows = (await result.stdout()).split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\.\/(.+)$/);
    if (!match) throw new Error("The builder workspace manifest was malformed.");
    const safePath = safeWorkspacePath(match[2]);
    return safePath ? { sha256: match[1], path: safePath } : undefined;
  }).filter((row): row is { sha256: string; path: string } => Boolean(row))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!rows.length || rows.length > MAX_WORKSPACE_FILES) {
    throw new Error(`The builder workspace must contain 1-${MAX_WORKSPACE_FILES} editable source files.`);
  }
  return rows;
}

export async function getBuilderWorkspaceManifest(sandboxName: string) {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  return builderWorkspaceManifest(sandbox);
}

function commandResult(exitCode: number, stdout: string, stderr: string, durationMs?: number) {
  return { exitCode, stdout: boundedBuilderOutput(stdout), stderr: boundedBuilderOutput(stderr), durationMs: durationMs || 0 };
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
) {
  const output = new Array<TOutput>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

function workspaceRowsSha256(rows: ReadonlyArray<{ path: string; sha256: string }>) {
  return builderFileSha256(rows.map((row) => `${row.path}\u0000${row.sha256}`).join("\n"));
}

function workspaceFindExclusions() {
  return [
    "-not", "-path", "./node_modules/*",
    "-not", "-path", "./.next/*",
    "-not", "-path", "./next-env.d.ts",
    "-not", "-name", "*.tsbuildinfo",
  ];
}

function safeWorkspacePath(value: string) {
  try {
    const normalized = value.trim().replaceAll("\\", "/");
    if (normalized.length > 240) return undefined;
    return safeBuilderRelativePath(normalized);
  } catch {
    return undefined;
  }
}

async function validateRepositoryArchive(sandbox: Sandbox) {
  const listed = await sandbox.runCommand({
    cmd: "tar",
    args: ["-tzf", REPOSITORY_ARCHIVE_PATH],
    timeoutMs: 30_000,
  });
  if (listed.exitCode !== 0) throw new Error("GitHub repository archive could not be inspected.");
  const members = (await listed.stdout()).split("\n").filter(Boolean);
  if (!members.length || members.length > MAX_WORKSPACE_FILES + 2_000) {
    throw new Error("GitHub repository archive is outside the 12,000-entry checkout boundary.");
  }
  const root = members[0].split("/")[0];
  if (!root || members.some((member) => !safeArchiveMember(member, root))) {
    throw new Error("GitHub repository archive contains an unsafe path.");
  }
  const verbose = await sandbox.runCommand({
    cmd: "tar",
    args: ["-tvzf", REPOSITORY_ARCHIVE_PATH],
    timeoutMs: 30_000,
  });
  if (verbose.exitCode !== 0 || (await verbose.stdout()).split("\n").some((line) => line.startsWith("l") || line.startsWith("h"))) {
    throw new Error("GitHub repository archive contains unsupported linked entries.");
  }
}

function safeArchiveMember(member: string, root: string) {
  if (!member || member.includes("\0") || member.includes("\\") || member.startsWith("/")) return false;
  const segments = member.split("/").filter(Boolean);
  return segments[0] === root && segments.every((segment) => segment !== "." && segment !== "..");
}

async function readRepositoryBaseline(sandbox: Sandbox): Promise<RepositoryBaseline | null> {
  const buffer = await sandbox.readFileToBuffer({ path: REPOSITORY_BASELINE_PATH });
  if (!buffer) return null;
  if (buffer.byteLength > 2_000_000) throw new Error("Repository workspace baseline is oversized.");
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw new Error("Repository workspace baseline is malformed."); }
  const candidate = value as Partial<RepositoryBaseline>;
  if (
    candidate.contractVersion !== APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION ||
    !/^\d{1,24}$/.test(candidate.repositoryId || "") ||
    !/^[a-f0-9]{40,64}$/.test(candidate.baseSha || "") ||
    !/^[a-f0-9]{64}$/.test(candidate.archiveSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(candidate.workspaceSha256 || "") ||
    !candidate.repositoryFullName || !candidate.importedAt ||
    !Array.isArray(candidate.entries) || candidate.entries.length !== candidate.fileCount ||
    candidate.entries.length < 1 || candidate.entries.length > MAX_WORKSPACE_FILES ||
    candidate.entries.some((entry) => !safeWorkspacePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))
  ) throw new Error("Repository workspace baseline failed integrity validation.");
  return candidate as RepositoryBaseline;
}

function publicRepositoryWorkspace(baseline: RepositoryBaseline): AppBuilderRepositoryWorkspace {
  const { entries: _entries, ...workspace } = baseline;
  return workspace;
}

function changePath(change: AppBuilderDeliveryChange) {
  return change.kind === "upsert" ? change.file.path : change.path;
}
