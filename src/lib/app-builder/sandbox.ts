import "server-only";

import { createHmac } from "node:crypto";
import { APIError, Sandbox } from "@vercel/sandbox";
import { getAppBaseUrl } from "@/lib/config";
import {
  APP_BUILDER_APP_PORT,
  APP_BUILDER_PREVIEW_PORT,
  APP_BUILDER_REPOSITORY_WORKSPACE_CONTRACT_VERSION,
  APP_BUILDER_ROOT,
  APP_BUILDER_EXCLUDED_SEGMENTS,
  APP_BUILDER_MAX_ARCHIVE_BYTES,
  APP_BUILDER_MAX_EXPANDED_BYTES,
  APP_BUILDER_MAX_WORKSPACE_FILES,
  APP_BUILDER_MAX_INSPECT_BYTES,
  applyBuilderTextEdits,
  isBuilderExcludedPath,
  resolveBuilderCommandSpecification,
  boundedBuilderOutput,
  builderFileSha256,
  safeBuilderRelativePath,
  safeBuilderFrameworkDocPath,
  sliceAppBuilderFileContent,
  type AppBuilderCommandKind,
  type AppBuilderCommandResult,
  type AppBuilderDeliveryChange,
  type AppBuilderFile,
  type AppBuilderRepositoryWorkspace,
  type AppBuilderTreeEntry,
  type AppBuilderTestSummary,
  type AppBuilderWorkspaceMode,
  type AppBuilderTextEdit,
} from "@/lib/app-builder/contracts";
import { appBuilderStarterTemplate } from "@/lib/app-builder/templates";

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 8 * 60 * 1_000;
const FOCUSED_COMMAND_TIMEOUT_MS = 180_000;
const DIRECT_TYPECHECK_TIMEOUT_MS = 240_000;
const CHECKPOINT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WORKSPACE_FILES = APP_BUILDER_MAX_WORKSPACE_FILES;
const REPOSITORY_ARCHIVE_PATH = "/vercel/sandbox/asael-repository-source.tar.gz";
const REPOSITORY_BASELINE_PATH = "/vercel/sandbox/asael-repository-baseline.json";

export async function builderSandboxExists(sandboxName: string): Promise<boolean> {
  try {
    await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
    return true;
  } catch (error) {
    if (error instanceof APIError) {
      const body = error.json as { error?: { code?: string } } | undefined;
      if (error.response.status === 404 || (error.response.status === 410 && body?.error?.code === "snapshot_not_found")) return false;
    }
    throw error;
  }
}

type RepositoryBaseline = AppBuilderRepositoryWorkspace & Readonly<{
  entries: ReadonlyArray<WorkspaceRow>;
}>;

type WorkspaceRow = Readonly<{ path: string; sha256: string; mode?: "100644" | "100755" }>;
type IndexedFile = AppBuilderTreeEntry & { kind: "file"; mode: "100644" | "100755"; sha256?: string; matched?: boolean };

// Runs without a shell. Source paths and queries are data arguments, never code.
export const builderWorkspaceIndexSource = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = ${JSON.stringify(APP_BUILDER_ROOT)};
const exclusions = new Set(${JSON.stringify(APP_BUILDER_EXCLUDED_SEGMENTS)});
const mode = process.argv[1];
const query = process.argv[2] || "";
const rows = [];
let totalBytes = 0;
function excluded(relative, name) {
  name = name.toLowerCase();
  return exclusions.has(name) || name === ".env" || name.startsWith(".env.") ||
    [".npmrc", ".netrc", ".pypirc", ".git-credentials", "credentials.json", "credentials", "id_rsa", "id_ed25519"].includes(name) ||
    /\\.(pem|p12|pfx|key|keystore|jks)$/i.test(name) || name.endsWith(".tsbuildinfo") ||
    relative === "next-env.d.ts" || relative === ".config/gcloud" || relative.startsWith(".config/gcloud/");
}
async function walk(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? relative + "/" + entry.name : entry.name;
    if (excluded(child, entry.name)) continue;
    if (child.length > 240) throw new Error("Workspace source path exceeds the 240-character boundary.");
    const absolute = path.join(root, child);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Workspace contains unsupported linked or special source entries.");
    if (stat.isDirectory()) { await walk(child); continue; }
    if (stat.nlink !== 1) throw new Error("Workspace contains unsupported hard-linked source entries.");
    if (rows.length >= ${MAX_WORKSPACE_FILES}) throw new Error("Workspace exceeds the source-file boundary.");
    totalBytes += stat.size;
    if (totalBytes > ${APP_BUILDER_MAX_EXPANDED_BYTES}) throw new Error("Workspace exceeds the source-byte boundary.");
    const row = { path: child, kind: "file", size: stat.size, mode: stat.mode & 0o111 ? "100755" : "100644" };
    if (mode === "manifest") {
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
      row.sha256 = hash.digest("hex");
    }
    if (mode === "search") {
      row.matched = child.toLowerCase().includes(query.toLowerCase());
      if (!row.matched && stat.size <= ${APP_BUILDER_MAX_INSPECT_BYTES}) {
        const bytes = fs.readFileSync(absolute);
        row.matched = !bytes.includes(0) && bytes.toString("utf8").includes(query);
      }
    }
    rows.push(row);
  }
}
(async () => {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid workspace root.");
  await walk("");
  process.stdout.write(JSON.stringify(rows));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
`;

const inspectBuilderPathsSource = `
const fs = require("node:fs");
const root = ${JSON.stringify(APP_BUILDER_ROOT)};
const paths = JSON.parse(process.argv[1]);
const allowMissing = process.argv[2] === "true";
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid workspace root.");
const result = paths.map((relative) => {
  let current = root;
  let final;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current += "/" + parts[index];
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && error.code === "ENOENT") return { path: relative, missing: true };
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error("Builder source path contains linked or non-regular entries.");
    }
    final = stat;
  }
  return { path: relative, mode: final.mode & 0o111 ? "100755" : "100644", size: final.size };
});
process.stdout.write(JSON.stringify(result));
`;

/** Explicit credentials support a non-Vercel worker; all-absent retains SDK OIDC. */
export function builderSandboxCredentials() {
  const token = process.env.OMNIAGENT_SANDBOX_ACCESS_TOKEN?.trim();
  const teamId = process.env.OMNIAGENT_SANDBOX_TEAM_ID?.trim();
  const projectId = process.env.OMNIAGENT_SANDBOX_PROJECT_ID?.trim();
  if (!token && !teamId && !projectId) return {};
  if (!token || !teamId || !projectId) throw new Error("Sandbox credentials require an access token, team ID and project ID together.");
  return { token, teamId, projectId };
}

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
  workspaceMode?: AppBuilderWorkspaceMode;
}) {
  const sourceOnly = input.workspaceMode === "source_only";
  const sandbox = await Sandbox.create({
    ...builderSandboxCredentials(),
    name: input.sandboxName,
    image: "vercel/sandbox/node:24",
    ...(sourceOnly ? {} : { ports: [APP_BUILDER_PREVIEW_PORT] }),
    timeout: SANDBOX_TIMEOUT_MS,
    // The installed SDK allocates 2048 MB/vCPU. Direct repository type checking has a 6 GB heap ceiling.
    resources: { vcpus: sourceOnly ? 4 : 2 },
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
    ...(sourceOnly ? [] : [{ path: "/vercel/sandbox/asael-preview-proxy.mjs", content: previewProxySource, mode: 0o500 }]),
  ]);
  if (sourceOnly) return { install: { ...commandResult(0, "Starter dependency installation skipped for source-only work.", "", 0), skipped: true }, previewUrl: null };
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
  workspaceMode?: AppBuilderWorkspaceMode;
}) {
  if (input.workspaceMode === "source_only") return null;
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName });
  return previewUrl(sandbox, previewToken(input));
}

async function readWorkspaceIndex(sandbox: Sandbox, mode: "index" | "manifest" | "search", query = ""): Promise<IndexedFile[]> {
  const result = await sandbox.runCommand({
    cmd: "node", args: ["-e", builderWorkspaceIndexSource, mode, query],
    cwd: APP_BUILDER_ROOT, timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error("The builder source index failed its path, link or size boundary.");
  const output = await result.stdout();
  if (Buffer.byteLength(output) > 8_000_000) throw new Error("The builder source index is oversized.");
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows) || rows.length > MAX_WORKSPACE_FILES) throw new Error("The builder source index is outside its file-count boundary.");
  const seen = new Set<string>();
  return rows.map((row): IndexedFile => {
    if (!row || typeof row !== "object" || typeof row.path !== "string" || row.kind !== "file" ||
        !Number.isSafeInteger(row.size) || row.size < 0 || !["100644", "100755"].includes(row.mode) ||
        (mode === "manifest" && !/^[a-f0-9]{64}$/.test(row.sha256 || ""))) throw new Error("The builder source index is malformed.");
    const path = safeBuilderRelativePath(row.path);
    if (seen.has(path)) throw new Error("The builder source index contains duplicate paths.");
    seen.add(path);
    return { ...row, path };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function sourceTree(rows: readonly IndexedFile[]): AppBuilderTreeEntry[] {
  const directories = new Set<string>();
  for (const row of rows) {
    const pieces = row.path.split("/");
    for (let index = 1; index < pieces.length; index += 1) directories.add(pieces.slice(0, index).join("/"));
  }
  return [
    ...[...directories].map((path) => ({ path, kind: "directory" as const })),
    ...rows.map(({ path, size }) => ({ path, kind: "file" as const, size })),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

/** Complete bounded index for internal callers; never silently takes the first 500 files. */
export async function listBuilderFiles(sandboxName: string): Promise<AppBuilderTreeEntry[]> {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
  return sourceTree(await readWorkspaceIndex(sandbox, "index"));
}

export async function listBuilderFilesPage(sandboxName: string, options: { cursor?: string; limit?: number } = {}) {
  const entries = await listBuilderFiles(sandboxName);
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Builder source pages must contain 1-500 entries.");
  const digest = builderFileSha256(JSON.stringify(entries));
  let offset = 0;
  if (options.cursor) {
    const match = options.cursor.match(/^([a-f0-9]{64}):([0-9]{1,5})$/);
    if (!match || match[1] !== digest) throw new Error("The builder source index changed; restart pagination.");
    offset = Number(match[2]);
    if (offset >= entries.length) throw new Error("Builder source cursor is out of bounds.");
  }
  const next = offset + limit;
  return { entries: entries.slice(offset, next), total: entries.length, truncated: next < entries.length,
    ...(next < entries.length ? { nextCursor: `${digest}:${next}` } : {}) };
}

export async function searchBuilderFiles(input: { sandboxName: string; query: string }) {
  const query = input.query.trim();
  if (query.length < 2 || query.length > 120) throw new Error("Builder search requires a 2-120 character literal query.");
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  const rows = await readWorkspaceIndex(sandbox, "search", query);
  return rows.filter((row) => row.matched).slice(0, 100).map(({ path, size }) => ({ path, kind: "file" as const, size }));
}

async function inspectBuilderPaths(sandbox: Sandbox, paths: readonly string[], allowMissing = false) {
  paths.forEach(safeBuilderRelativePath);
  const result = await sandbox.runCommand({
    cmd: "node", args: ["-e", inspectBuilderPathsSource, JSON.stringify(paths), String(allowMissing)],
    cwd: APP_BUILDER_ROOT, timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("Builder source must be a regular file without linked path components.");
  const rows = JSON.parse(await result.stdout()) as Array<{ path: string; mode?: "100644" | "100755"; size?: number; missing?: boolean }>;
  if (!Array.isArray(rows) || rows.length !== paths.length || rows.some((row, index) => row.path !== paths[index] ||
      (row.missing ? !allowMissing : !["100644", "100755"].includes(row.mode || "") || !Number.isSafeInteger(row.size)))) {
    throw new Error("Builder source inspection failed its integrity check.");
  }
  return rows;
}

async function readBuilderFullFile(sandboxName: string, requestedPath: string): Promise<AppBuilderFile> {
  const relativePath = safeBuilderRelativePath(requestedPath);
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
  const [metadata] = await inspectBuilderPaths(sandbox, [relativePath]);
  if ((metadata.size || 0) > APP_BUILDER_MAX_INSPECT_BYTES) throw new Error("Builder file is too large to inspect in this workspace.");
  const buffer = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  if (!buffer) throw new Error("Builder file was not found.");
  if (buffer.byteLength > APP_BUILDER_MAX_INSPECT_BYTES) throw new Error("Builder file is too large to inspect in this workspace.");
  const content = buffer.toString("utf8");
  if (buffer.includes(0) || !Buffer.from(content, "utf8").equals(buffer)) throw new Error("Builder source editing supports UTF-8 text files only.");
  return { path: relativePath, content, sha256: builderFileSha256(buffer), size: buffer.byteLength, mode: metadata.mode };
}

export async function readBuilderFile(
  sandboxName: string,
  requestedPath: string,
  range?: Readonly<{ startLine: number; lineCount: number }>,
): Promise<AppBuilderFile> {
  const file = await readBuilderFullFile(sandboxName, requestedPath);
  return { path: file.path, ...sliceAppBuilderFileContent(file.content, range), sha256: file.sha256, size: file.size };
}

export const builderFrameworkDocReadSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(APP_BUILDER_ROOT)};
const relative = process.argv[1];
const parts = ['node_modules', 'next', 'dist', 'docs', ...relative.split('/')];
let current = root;
for (let index = 0; index < parts.length; index++) {
  current = path.join(current, parts[index]);
  const item = fs.lstatSync(current);
  if (item.isSymbolicLink() || (index < parts.length - 1 ? !item.isDirectory() : !item.isFile() || item.nlink !== 1 || item.size > 262144)) throw new Error('Framework documentation must be an unlinked bounded markdown file.');
}
const value = fs.readFileSync(current);
if (value.length > 262144) throw new Error('Framework documentation exceeds its byte boundary.');
process.stdout.write(JSON.stringify({content: value.toString('base64')}));
`;

/** Deliberately separate from editable source paths, indexing, checkpoint hashing and delivery. */
export async function readBuilderFrameworkDoc(sandboxName: string, requestedPath: string, range: { startLine: number; lineCount: number }) {
  const path = safeBuilderFrameworkDocPath(requestedPath);
  if (!Number.isInteger(range.startLine) || range.startLine < 1 || range.startLine > 100_000 || !Number.isInteger(range.lineCount) || range.lineCount < 1 || range.lineCount > 200) throw new Error("Framework documentation requires a bounded line range.");
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
  const result = await sandbox.runCommand({ cmd: "node", args: ["-e", builderFrameworkDocReadSource, path], cwd: APP_BUILDER_ROOT, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error("The installed Next.js guide is unavailable or failed its file boundary.");
  const output = await result.stdout();
  if (output.length > 360_000) throw new Error("Framework documentation exceeds its output boundary.");
  const decoded: unknown = JSON.parse(output);
  if (!decoded || typeof decoded !== "object" || !("content" in decoded) || typeof decoded.content !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(decoded.content)) throw new Error("Framework documentation is malformed.");
  const buffer = Buffer.from(decoded.content, "base64"), content = buffer.toString("utf8");
  if (buffer.length > 262144 || buffer.includes(0) || !Buffer.from(content).equals(buffer)) throw new Error("Framework documentation must be bounded UTF-8 text.");
  return { framework: "next" as const, basePath: "node_modules/next/dist/docs", file: { path, ...sliceAppBuilderFileContent(content, range), sha256: builderFileSha256(buffer), size: buffer.length } };
}

export async function readBuilderWorkspaceFiles(sandboxName: string): Promise<AppBuilderFile[]> {
  const entries = (await listBuilderFiles(sandboxName)).filter(
    (entry): entry is AppBuilderTreeEntry & { kind: "file" } => entry.kind === "file",
  );
  if (entries.length > 500 || entries.reduce((sum, entry) => sum + (entry.size || 0), 0) > 8_000_000) {
    throw new Error("The complete builder workspace exceeds the reviewed 500-file / 8 MB delivery boundary; use repository change delivery.");
  }
  const files = await mapWithConcurrency(entries, 8, (entry) => readBuilderFullFile(sandboxName, entry.path));
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
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  const [metadata] = await inspectBuilderPaths(sandbox, [relativePath], true);
  if (Buffer.byteLength(input.content) > 500_000) throw new Error("Builder source updates must be at most 500 KB.");
  const current = await sandbox.readFileToBuffer({ path: `${APP_BUILDER_ROOT}/${relativePath}` });
  const currentSha256 = current ? builderFileSha256(current) : null;
  if (currentSha256 !== input.expectedSha256) {
    throw new Error("Builder file changed after it was inspected. Read it again before applying an update.");
  }
  const parent = relativePath.split("/").slice(0, -1).join("/");
  if (parent) await sandbox.runCommand({ cmd: "mkdir", args: ["-p", `${APP_BUILDER_ROOT}/${parent}`], timeoutMs: 10_000 });
  await sandbox.writeFiles([{ path: `${APP_BUILDER_ROOT}/${relativePath}`, content: input.content, mode: metadata.mode === "100755" ? 0o755 : 0o644 }]);
  return { path: relativePath, previousSha256: currentSha256, sha256: builderFileSha256(input.content), size: Buffer.byteLength(input.content) };
}

export async function editBuilderFile(input: {
  sandboxName: string; path: string; expectedSha256: string; edits: readonly AppBuilderTextEdit[];
}) {
  const file = await readBuilderFullFile(input.sandboxName, input.path);
  if (file.sha256 !== input.expectedSha256) throw new Error("Builder file changed after it was inspected. Read it again before applying an edit.");
  const content = applyBuilderTextEdits(file.content, input.edits);
  // The canonical writer rechecks the source hash immediately before writing,
  // retains the file mode and applies the same path/link/size restrictions.
  return { ...await updateBuilderFile({ sandboxName: input.sandboxName, path: file.path, expectedSha256: input.expectedSha256, content }), replacementCount: input.edits.length };
}

export async function deleteBuilderFile(input: {
  sandboxName: string;
  path: string;
  expectedSha256: string;
}) {
  const relativePath = safeBuilderRelativePath(input.path);
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  await inspectBuilderPaths(sandbox, [relativePath]);
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
  workspaceMode?: AppBuilderWorkspaceMode;
}) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  if (input.archive.byteLength > APP_BUILDER_MAX_ARCHIVE_BYTES || builderFileSha256(input.archive) !== input.archiveSha256) {
    throw new Error("Repository archive failed its compressed-size or digest boundary.");
  }
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
    if (input.workspaceMode !== "source_only") await startBuilderPreview(sandbox, previewToken(input.previewIdentity));
    return {
      workspace: publicRepositoryWorkspace(baseline),
      install: commandResult(install.exitCode, stdout, stderr, install.durationMs),
      previewUrl: input.workspaceMode === "source_only" ? null : previewUrl(sandbox, previewToken(input.previewIdentity)),
    };
  } finally {
    await sandbox.runCommand({ cmd: "rm", args: ["-f", "--", REPOSITORY_ARCHIVE_PATH], timeoutMs: 10_000 }).catch(() => undefined);
  }
}

export async function getBuilderRepositoryWorkspace(sandboxName: string) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
  const baseline = await readRepositoryBaseline(sandbox);
  return baseline ? publicRepositoryWorkspace(baseline) : null;
}

export async function readBuilderRepositoryChanges(input: {
  sandboxName: string;
  repositoryId: string;
  baseSha: string;
}): Promise<AppBuilderDeliveryChange[]> {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  const baseline = await readRepositoryBaseline(sandbox);
  if (!baseline || baseline.repositoryId !== input.repositoryId || baseline.baseSha !== input.baseSha) {
    throw new Error("The builder workspace is not checked out from this exact repository revision.");
  }
  const currentRows = await builderWorkspaceRows(sandbox);
  const current = new Map(currentRows.map((row) => [row.path, row.sha256]));
  const previous = new Map(baseline.entries.map((row) => [row.path, row]));
  const changes: AppBuilderDeliveryChange[] = [];
  for (const row of currentRows) {
    const prior = previous.get(row.path);
    if (prior?.sha256 !== row.sha256 || (prior.mode !== undefined && prior.mode !== row.mode)) {
      changes.push({ kind: "upsert", file: await readBuilderFullFile(input.sandboxName, row.path), previousSha256: prior?.sha256 ?? null, ...(prior?.mode ? { previousMode: prior.mode } : {}) });
    }
  }
  for (const row of baseline.entries) {
    if (!current.has(row.path)) changes.push({ kind: "delete", path: row.path, previousSha256: row.sha256, ...(row.mode ? { previousMode: row.mode } : {}) });
  }
  if (changes.length > 500) throw new Error("Repository delivery exceeds the 500-change review boundary.");
  return changes.sort((left, right) => changePath(left).localeCompare(changePath(right)));
}

export async function runBuilderCommand(input: {
  sandboxName: string;
  command: AppBuilderCommandKind;
  paths?: readonly string[];
  previewIdentity?: { tenantId: string; ownerActorId: string; projectId: string; sessionId: string };
  workspaceMode?: AppBuilderWorkspaceMode;
}): Promise<AppBuilderCommandResult> {
  const specification = resolveBuilderCommandSpecification(input);
  if (input.command === "start_preview" && input.workspaceMode === "source_only") throw new Error("Source-only workspaces do not start application previews.");
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  if (specification.paths.length) await inspectBuilderPaths(sandbox, specification.paths);
  if (input.command === "start_preview") {
    if (!input.previewIdentity) throw new Error("Preview identity is required.");
    await startBuilderPreview(sandbox, previewToken(input.previewIdentity));
    return { command: input.command, exitCode: 0, stdout: "Preview restarted.", stderr: "", durationMs: 0 };
  }
  const startedAt = Date.now();
  // Direct type checking includes route generation and the full project compiler pass.
  const boundedTimeoutMs = input.command === "typecheck_direct" ? DIRECT_TYPECHECK_TIMEOUT_MS
    : specification.paths.length ? FOCUSED_COMMAND_TIMEOUT_MS : undefined;
  let preparationStdout = "", preparationStderr = "", preparationDuration = 0;
  if (specification.preparation) {
    const prepared = await sandbox.runCommand({ cmd: specification.preparation.cmd, args: [...specification.preparation.args], cwd: APP_BUILDER_ROOT, timeoutMs: 60_000 });
    [preparationStdout, preparationStderr] = await Promise.all([prepared.stdout(), prepared.stderr()]);
    preparationDuration = prepared.durationMs || 0;
    if (prepared.exitCode !== 0) return { command: input.command, specification, ...commandResult(prepared.exitCode, preparationStdout, preparationStderr, preparationDuration) };
  }
  const result = await sandbox.runCommand({
    cmd: specification.cmd, args: [...specification.args], cwd: APP_BUILDER_ROOT,
    timeoutMs: boundedTimeoutMs === undefined ? COMMAND_TIMEOUT_MS : Math.max(1, boundedTimeoutMs - (Date.now() - startedAt)),
    ...(input.command === "test_focused" ? { env: { NODE_ENV: "test", VERCEL: "", VERCEL_ENV: "" } } : {}),
  });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  let testSummary: AppBuilderTestSummary | undefined;
  if (input.command === "test_focused") {
    try { testSummary = parseBuilderFocusedTestSummary(stdout, specification.paths); }
    catch {
      // Retain completed diagnostics for preparation without inventing test
      // counts. Ordinary validation still receives an explicitly failed result.
      return { command: input.command, specification,
        testReportError: { reason: "invalid_or_unexecuted", actualExitCode: result.exitCode },
        ...commandResult(result.exitCode || 1, stdout, stderr, preparationDuration + (result.durationMs || 0)) };
    }
  }
  const exitCode = result.exitCode || (testSummary && !testSummary.success ? 1 : 0);
  return { command: input.command, specification, ...(testSummary ? { testSummary } : {}), ...commandResult(exitCode, preparationStdout ? `${preparationStdout}\n${stdout}` : stdout, preparationStderr ? `${preparationStderr}\n${stderr}` : stderr, preparationDuration + (result.durationMs || 0)) };
}

export function parseBuilderFocusedTestSummary(output: string, expectedPaths: readonly string[]): AppBuilderTestSummary {
  if (Buffer.byteLength(output) > 8_000_000) throw new Error("Focused test execution evidence exceeds its byte boundary.");
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Focused tests did not return valid JSON execution evidence."); }
  if (!value || typeof value !== "object") throw new Error("Focused test execution evidence is malformed.");
  const report = value as { success?: unknown; testResults?: unknown };
  if (typeof report.success !== "boolean" || !Array.isArray(report.testResults) || !report.testResults.length || report.testResults.length > 30) {
    throw new Error("Focused test execution evidence is empty or outside its suite boundary.");
  }
  const executedPaths: string[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let pendingTests = 0;
  for (const suite of report.testResults) {
    if (!suite || typeof suite.name !== "string" || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) throw new Error("Focused test suite evidence is malformed or not a non-empty test set.");
    const relative = suite.name.startsWith(`${APP_BUILDER_ROOT}/`) ? suite.name.slice(APP_BUILDER_ROOT.length + 1) : suite.name;
    const path = safeBuilderRelativePath(relative);
    if (!expectedPaths.includes(path) || executedPaths.includes(path)) throw new Error("Focused tests executed an unexpected or duplicate source file.");
    executedPaths.push(path);
    for (const assertion of suite.assertionResults) {
      if (assertion.status === "passed") passedTests++;
      else if (assertion.status === "failed") failedTests++;
      else if (["pending", "skipped", "todo", "disabled"].includes(assertion.status)) pendingTests++;
      else throw new Error("Focused test case status is unsupported.");
    }
  }
  const totalTests = passedTests + failedTests + pendingTests;
  if (!totalTests || totalTests > 10_000 || executedPaths.length !== expectedPaths.length) throw new Error("Focused tests did not execute every selected file with a bounded non-empty test set.");
  return { totalTests, passedTests, failedTests, pendingTests, executedPaths: executedPaths.sort(),
    success: report.success && failedTests === 0 && pendingTests === 0 && passedTests > 0 };
}

export async function stopBuilderSandbox(sandboxName: string) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName });
  await sandbox.stop();
}

export async function createBuilderSandboxCheckpoint(input: {
  sandboxName: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  workspaceMode?: AppBuilderWorkspaceMode;
}) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  const workspace = await builderWorkspaceManifest(sandbox);
  const snapshot = await sandbox.snapshot({ expiration: CHECKPOINT_EXPIRATION_MS });
  let url: string | null = null;
  if (input.workspaceMode !== "source_only") {
    const resumed = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
    await startBuilderPreview(resumed, previewToken(input));
    url = previewUrl(resumed, previewToken(input));
  }
  return {
    providerSnapshotId: snapshot.snapshotId,
    workspaceSha256: workspace.sha256,
    fileCount: workspace.fileCount,
    snapshotBytes: Math.max(0, snapshot.sizeBytes || 0),
    expiresAt: snapshot.expiresAt?.toISOString(),
    previewUrl: url,
  };
}

export async function restoreBuilderSandboxCheckpoint(input: {
  sandboxName: string;
  providerSnapshotId: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  sessionId: string;
  workspaceMode?: AppBuilderWorkspaceMode;
}) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName });
  await sandbox.stop().catch(() => undefined);
  await sandbox.update({ currentSnapshotId: input.providerSnapshotId });
  const resumed = await Sandbox.get({ ...builderSandboxCredentials(), name: input.sandboxName, resume: true });
  if (input.workspaceMode !== "source_only") await startBuilderPreview(resumed, previewToken(input));
  const workspace = await builderWorkspaceManifest(resumed);
  return {
    workspaceSha256: workspace.sha256,
    fileCount: workspace.fileCount,
    previewUrl: input.workspaceMode === "source_only" ? null : previewUrl(resumed, previewToken(input)),
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

async function builderWorkspaceRows(sandbox: Sandbox): Promise<WorkspaceRow[]> {
  const rows = await readWorkspaceIndex(sandbox, "manifest");
  if (!rows.length) throw new Error("The builder workspace must contain editable source files.");
  return rows.map((row) => ({ path: row.path, sha256: row.sha256!, mode: row.mode }));
}

export async function getBuilderWorkspaceManifest(sandboxName: string) {
  const sandbox = await Sandbox.get({ ...builderSandboxCredentials(), name: sandboxName, resume: true });
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

function workspaceRowsSha256(rows: readonly WorkspaceRow[]) {
  return builderFileSha256(rows.map((row) => `${row.path}\u0000${row.sha256}\u0000${row.mode || "100644"}`).join("\n"));
}

function safeWorkspacePath(value: string) {
  if (isBuilderExcludedPath(value)) return undefined;
  return safeBuilderRelativePath(value);
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
  if (verbose.exitCode !== 0) throw new Error("GitHub repository archive could not be inspected.");
  validateBuilderArchiveListing(await verbose.stdout());
}

export function validateBuilderArchiveListing(output: string) {
  let bytes = 0;
  const rows = output.split("\n").filter(Boolean);
  if (!rows.length || rows.length > MAX_WORKSPACE_FILES + 2_000) throw new Error("GitHub repository archive exceeds its entry boundary.");
  for (const line of rows) {
    const match = line.match(/^([-d])[rwxstST-]{9}\s+\S+\s+(\d+)\s/);
    if (!match) throw new Error("GitHub repository archive contains unsupported linked or special entries.");
    bytes += Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes > APP_BUILDER_MAX_EXPANDED_BYTES) throw new Error("GitHub repository archive exceeds the 512 MiB expanded boundary.");
  }
  return { entries: rows.length, byteCount: bytes };
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
    candidate.entries.some((entry) => !safeWorkspacePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.mode !== undefined && !["100644", "100755"].includes(entry.mode)))
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
