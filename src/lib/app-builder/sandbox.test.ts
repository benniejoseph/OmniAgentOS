import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_BUILDER_ROOT, builderFileSha256 } from "@/lib/app-builder/contracts";

const sandboxMocks = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), mkdir: vi.fn(), snapshot: vi.fn(), stop: vi.fn(), update: vi.fn(), runCommand: vi.fn(), readFileToBuffer: vi.fn(), writeFiles: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/sandbox", () => ({ APIError: class APIError extends Error { constructor(public response: Response, public options?: { json?: unknown }) { super("Synthetic provider failure"); } get json() { return this.options?.json; } }, Sandbox: { get: sandboxMocks.get, create: sandboxMocks.create } }));

const execute = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "asael-builder-source-"));
  for (const mock of Object.values(sandboxMocks)) mock.mockReset();
  const fake = { fs: { mkdir: sandboxMocks.mkdir }, snapshot: sandboxMocks.snapshot, stop: sandboxMocks.stop, update: sandboxMocks.update, runCommand: sandboxMocks.runCommand, readFileToBuffer: sandboxMocks.readFileToBuffer, writeFiles: sandboxMocks.writeFiles };
  sandboxMocks.get.mockResolvedValue(fake);
  sandboxMocks.create.mockResolvedValue(fake);
  sandboxMocks.snapshot.mockResolvedValue({ snapshotId: "snapshot-fixture", sizeBytes: 12 });
  sandboxMocks.stop.mockResolvedValue(undefined);
  sandboxMocks.update.mockResolvedValue(undefined);
  sandboxMocks.runCommand.mockImplementation(async (command) => {
    if (command.cmd !== "node" || command.args[0] !== "-e") throw new Error("Unexpected command in isolated source fixture.");
    try {
      const { stdout, stderr } = await execute(process.execPath, ["-e", command.args[1].replace(JSON.stringify(APP_BUILDER_ROOT), JSON.stringify(directory)), ...command.args.slice(2)], { maxBuffer: 8_000_000 });
      return commandResult(stdout, 0, stderr);
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return commandResult(failed.stdout || "", 1, failed.stderr || "");
    }
  });
  sandboxMocks.readFileToBuffer.mockImplementation(async ({ path: requested }) => {
    try { return await readFile(requested.replace(APP_BUILDER_ROOT, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  sandboxMocks.writeFiles.mockImplementation(async (files) => {
    for (const file of files) {
      const destination = file.path.replace(APP_BUILDER_ROOT, directory);
      await writeFile(destination, file.content);
      if (file.mode !== undefined) await chmod(destination, file.mode);
    }
  });
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function source(relative: string, content: string) {
  const location = path.join(directory, relative);
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, content);
  return location;
}

function commandResult(stdout: string, exitCode = 0, stderr = "") {
  return { exitCode, stdout: async () => stdout, stderr: async () => stderr, durationMs: 1 };
}

describe("App Builder repository source boundary", () => {
  it("edits exact text with the canonical writer, preserves mode and rejects stale or ambiguous source", async () => {
    const { editBuilderFile } = await import("@/lib/app-builder/sandbox");
    const content = "#!/usr/bin/env node\nconst value = 1;\n", location = await source("script.js", content);
    await chmod(location, 0o755);
    const input = { sandboxName: "test", path: "script.js", expectedSha256: builderFileSha256(content), edits: [{ oldText: "value = 1", newText: "value = 2" }] };
    const result = await editBuilderFile(input);
    expect(result).toMatchObject({ replacementCount: 1, previousSha256: input.expectedSha256, sha256: builderFileSha256(content.replace("value = 1", "value = 2")) });
    expect(await readFile(location, "utf8")).toBe(content.replace("value = 1", "value = 2"));
    expect((await stat(location)).mode & 0o777).toBe(0o755);
    sandboxMocks.writeFiles.mockClear();
    await expect(editBuilderFile(input)).rejects.toThrow(/changed after/);
    await expect(editBuilderFile({ ...input, expectedSha256: result.sha256, edits: [{ oldText: "missing", newText: "x" }] })).rejects.toThrow(/exactly once/);
    await expect(editBuilderFile({ ...input, path: "../script.js" })).rejects.toThrow();
    await symlink(location, path.join(directory, "link.js"));
    await expect(editBuilderFile({ ...input, path: "link.js" })).rejects.toThrow();
    expect(sandboxMocks.writeFiles).not.toHaveBeenCalled();
  });

  it("rechecks an edited file hash if source changes between inspection and canonical write", async () => {
    const { editBuilderFile } = await import("@/lib/app-builder/sandbox");
    const content = "const value = 1;", location = await source("source.js", content);
    sandboxMocks.readFileToBuffer.mockResolvedValueOnce(Buffer.from(content)).mockResolvedValueOnce(Buffer.from("concurrent change"));
    await expect(editBuilderFile({ sandboxName: "test", path: "source.js", expectedSha256: builderFileSha256(content), edits: [{ oldText: "1", newText: "2" }] })).rejects.toThrow(/changed after/);
    expect(sandboxMocks.writeFiles).not.toHaveBeenCalled();
    expect(await readFile(location, "utf8")).toBe(content);
  });

  it("reads only bounded installed Next documentation without weakening editable source paths", async () => {
    const { readBuilderFrameworkDoc, listBuilderFiles, updateBuilderFile } = await import("@/lib/app-builder/sandbox");
    const guide = "01-app/01-getting-started/01-installation.md";
    const location = await source(`node_modules/next/dist/docs/${guide}`, "First line\nSecond line\nThird line\n");
    const result = await readBuilderFrameworkDoc("test", guide, { startLine: 2, lineCount: 1 });
    expect(result).toMatchObject({ framework: "next", file: { path: guide, content: "Second line", lineRange: { startLine: 2, truncated: true } } });
    expect(await listBuilderFiles("test")).toEqual([]);
    await expect(updateBuilderFile({ sandboxName: "test", path: `node_modules/next/dist/docs/${guide}`, expectedSha256: result.file.sha256, content: "changed" })).rejects.toThrow();
    for (const value of ["../../package.json", "/etc/passwd.md", "01-app/../private.md", "foo//guide.md", "script.js"]) await expect(readBuilderFrameworkDoc("test", value, { startLine: 1, lineCount: 20 })).rejects.toThrow();
    await rm(location); await symlink(await source("outside.md", "private"), location);
    await expect(readBuilderFrameworkDoc("test", guide, { startLine: 1, lineCount: 20 })).rejects.toThrow(/file boundary/);
  });

  it("source-only provisioning skips starter installation and previews with enough memory for direct checks", async () => {
    const { createBuilderSandbox, getBuilderPreviewUrl, runBuilderCommand } = await import("@/lib/app-builder/sandbox");
    sandboxMocks.writeFiles.mockResolvedValue(undefined);
    const identity = { sandboxName: "test", tenantId: "tenant", ownerActorId: "actor", projectId: "project", sessionId: "session", workspaceMode: "source_only" as const };
    const result = await createBuilderSandbox(identity);
    expect(result).toMatchObject({ previewUrl: null, install: { skipped: true, durationMs: 0 } });
    expect(sandboxMocks.create).toHaveBeenCalledWith(expect.objectContaining({ resources: { vcpus: 4 } }));
    expect(sandboxMocks.create.mock.calls[0][0].ports).toBeUndefined();
    expect(sandboxMocks.runCommand).not.toHaveBeenCalled();
    expect(await getBuilderPreviewUrl(identity)).toBeNull();
    await expect(runBuilderCommand({ ...identity, command: "start_preview" })).rejects.toThrow(/Source-only/);
    expect(sandboxMocks.get).not.toHaveBeenCalled();
  });

  it("source-only checkpoint and restore never start a background app", async () => {
    const { createBuilderSandboxCheckpoint, restoreBuilderSandboxCheckpoint } = await import("@/lib/app-builder/sandbox");
    await source("src/app/page.tsx", "export default function Page() { return null; }");
    const identity = { sandboxName: "test", tenantId: "tenant", ownerActorId: "actor", projectId: "project", sessionId: "session", workspaceMode: "source_only" as const };
    const checkpoint = await createBuilderSandboxCheckpoint(identity);
    expect(checkpoint.previewUrl).toBeNull();
    expect(sandboxMocks.get).toHaveBeenCalledTimes(1);
    const restored = await restoreBuilderSandboxCheckpoint({ ...identity, providerSnapshotId: "snapshot-fixture" });
    expect(restored).toMatchObject({ previewUrl: null, workspaceSha256: checkpoint.workspaceSha256 });
    expect(sandboxMocks.runCommand.mock.calls.every(([command]) => command.cmd === "node" && command.args[0] === "-e")).toBe(true);
  });

  it("source-only repository checkout installs exact dependencies without a preview process", async () => {
    const { checkoutBuilderRepositoryArchive } = await import("@/lib/app-builder/sandbox");
    await source("package.json", "{\"name\":\"fixture\"}"); await source("package-lock.json", "{}");
    const inspect = sandboxMocks.runCommand.getMockImplementation()!;
    sandboxMocks.runCommand.mockImplementation(async (command) => command.cmd === "node" ? inspect(command) : commandResult(command.args[0] === "-tzf" ? "repo/\nrepo/package.json\n" : command.args[0] === "-tvzf" ? "drwxr-xr-x root/root 0 2026-01-01 00:00 repo/\n-rw-r--r-- root/root 2 2026-01-01 00:00 repo/package.json\n" : ""));
    sandboxMocks.writeFiles.mockResolvedValue(undefined);
    const archive = Buffer.from("synthetic-provider-archive");
    const result = await checkoutBuilderRepositoryArchive({ sandboxName: "test", repositoryId: "123", repositoryFullName: "owner/repo", baseSha: "a".repeat(40), archive, archiveSha256: builderFileSha256(archive), previewIdentity: { tenantId: "tenant", ownerActorId: "actor", projectId: "project", sessionId: "session" }, workspaceMode: "source_only" });
    expect(result.previewUrl).toBeNull();
    expect(sandboxMocks.runCommand.mock.calls.filter(([command]) => command.cmd === "npm").map(([command]) => command.args)).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(sandboxMocks.runCommand.mock.calls.some(([command]) => command.detached)).toBe(false);
  });

  it("distinguishes explicit missing Sandbox evidence from transient or authorization failures", async () => {
    const { APIError } = await import("@vercel/sandbox");
    const { builderSandboxExists } = await import("@/lib/app-builder/sandbox");
    expect(await builderSandboxExists("test")).toBe(true);
    sandboxMocks.get.mockRejectedValueOnce(new APIError(new Response(null, { status: 404 })));
    expect(await builderSandboxExists("test")).toBe(false);
    sandboxMocks.get.mockRejectedValueOnce(new APIError(new Response(null, { status: 410 }), { json: { error: { code: "snapshot_not_found" } } }));
    expect(await builderSandboxExists("test")).toBe(false);
    sandboxMocks.get.mockRejectedValueOnce(new APIError(new Response(null, { status: 403 })));
    await expect(builderSandboxExists("test")).rejects.toThrow();
    sandboxMocks.get.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(builderSandboxExists("test")).rejects.toThrow(/timeout/);
  });

  it("prepares installed Next types before direct type checking and retains preparation failure", async () => {
    const { runBuilderCommand } = await import("@/lib/app-builder/sandbox");
    sandboxMocks.runCommand.mockResolvedValue(commandResult("types generated"));
    const result = await runBuilderCommand({ sandboxName: "test", command: "typecheck_direct", workspaceMode: "source_only" });
    expect(sandboxMocks.runCommand.mock.calls.map(([command]) => [command.cmd, command.args])).toEqual([
      ["node", ["node_modules/next/dist/bin/next", "typegen"]], ["node", ["--max-old-space-size=6144", "node_modules/typescript/bin/tsc", "--noEmit"]],
    ]);
    expect(result.specification?.preparation).toEqual({ cmd: "node", args: ["node_modules/next/dist/bin/next", "typegen"] });
    expect(sandboxMocks.runCommand.mock.calls[1][0].timeoutMs).toBeLessThanOrEqual(180_000);
    sandboxMocks.runCommand.mockClear(); sandboxMocks.runCommand.mockResolvedValue(commandResult("", 1, "type generation failed"));
    const failed = await runBuilderCommand({ sandboxName: "test", command: "typecheck_direct" });
    expect(failed).toMatchObject({ exitCode: 1, stderr: "type generation failed" });
    expect(sandboxMocks.runCommand).toHaveBeenCalledTimes(1);
  });

  it("indexes and hashes Next.js routes and dot sources without exposing credential files", async () => {
    await source("src/app/(studio)/[id]/page.tsx", "export default () => null");
    await source(".github/workflows/check.yml", "name: checks");
    await source(".env.production", "PRIVATE_FIXTURE=not-for-index");
    await source("keys/private.pem", "PRIVATE_FIXTURE");
    await source("next-env.d.ts", "generated");
    const { listBuilderFiles, getBuilderWorkspaceManifest } = await import("@/lib/app-builder/sandbox");
    const paths = (await listBuilderFiles("test")).filter((entry) => entry.kind === "file").map((entry) => entry.path);
    expect(paths).toEqual([".github/workflows/check.yml", "src/app/(studio)/[id]/page.tsx"]);
    const first = await getBuilderWorkspaceManifest("test");
    await source("src/app/(studio)/[id]/page.tsx", "export default () => 'changed'");
    const second = await getBuilderWorkspaceManifest("test");
    expect(first.fileCount).toBe(2);
    expect(second.sha256).not.toBe(first.sha256);
  });

  it("pages past 500 entries with a source-bound cursor and refuses silent whole-workspace truncation", async () => {
    await Promise.all(Array.from({ length: 510 }, (_, index) => source(`file-${String(index).padStart(3, "0")}.ts`, "export {}")));
    const { listBuilderFilesPage, listBuilderFiles, readBuilderWorkspaceFiles } = await import("@/lib/app-builder/sandbox");
    const first = await listBuilderFilesPage("test", { limit: 500 });
    expect(first).toMatchObject({ total: 510, truncated: true });
    expect(first.entries).toHaveLength(500);
    const second = await listBuilderFilesPage("test", { limit: 500, cursor: first.nextCursor });
    expect(second).toMatchObject({ total: 510, truncated: false });
    expect(second.entries).toHaveLength(10);
    expect(await listBuilderFiles("test")).toHaveLength(510);
    await expect(readBuilderWorkspaceFiles("test")).rejects.toThrow(/complete builder workspace exceeds/);
    await source("new.ts", "export {}");
    await expect(listBuilderFilesPage("test", { cursor: first.nextCursor })).rejects.toThrow(/changed/);
  });

  it("searches filename and content matches with accurate byte sizes beyond the first page", async () => {
    await source("docs/audit.md", "x".repeat(7168));
    await source("src/app/[id]/page.tsx", "audit");
    const { searchBuilderFiles } = await import("@/lib/app-builder/sandbox");
    await expect(searchBuilderFiles({ sandboxName: "test", query: "audit" })).resolves.toEqual([
      { path: "docs/audit.md", kind: "file", size: 7168 },
      { path: "src/app/[id]/page.tsx", kind: "file", size: 5 },
    ]);
  });

  it("rejects symlinked source files and parents before reading or updating", async () => {
    const target = await source("real/source.ts", "original");
    await symlink(target, path.join(directory, "linked.ts"));
    await symlink(path.dirname(target), path.join(directory, "linked-parent"));
    const { listBuilderFiles, readBuilderFile, updateBuilderFile } = await import("@/lib/app-builder/sandbox");
    await expect(listBuilderFiles("test")).rejects.toThrow(/source index failed/);
    await expect(readBuilderFile("test", "linked.ts")).rejects.toThrow(/regular file/);
    await expect(updateBuilderFile({ sandboxName: "test", path: "linked-parent/source.ts", expectedSha256: builderFileSha256("original"), content: "changed" })).rejects.toThrow(/regular file/);
    expect(sandboxMocks.readFileToBuffer).not.toHaveBeenCalled();
    expect(sandboxMocks.writeFiles).not.toHaveBeenCalled();
  });

  it("retains full delivery contents and executable mode while limiting public read slices", async () => {
    const contents = `${"// source\n".repeat(4000)}export {};`;
    const location = await source("script.ts", contents);
    await chmod(location, 0o755);
    const { readBuilderFile, readBuilderWorkspaceFiles } = await import("@/lib/app-builder/sandbox");
    const visible = await readBuilderFile("test", "script.ts", { startLine: 1, lineCount: 200 });
    expect(visible.content.length).toBeLessThan(contents.length);
    expect(visible.lineRange?.truncated).toBe(true);
    const [delivered] = await readBuilderWorkspaceFiles("test");
    expect(delivered).toMatchObject({ content: contents, sha256: builderFileSha256(contents), mode: "100755" });
    expect(delivered.lineRange).toBeUndefined();
  });

  it("rejects unsupported source paths instead of dropping them from hashes", async () => {
    await source("source;not-supported.ts", "export {}");
    const { getBuilderWorkspaceManifest } = await import("@/lib/app-builder/sandbox");
    await expect(getBuilderWorkspaceManifest("test")).rejects.toThrow(/bounded relative source path/);
  });

  it("binds focused execution to the exact validated argv and refuses missing files", async () => {
    await source("src/app/[id]/route.test.ts", "export {}");
    const { runBuilderCommand } = await import("@/lib/app-builder/sandbox");
    const original = sandboxMocks.runCommand.getMockImplementation()!;
    sandboxMocks.runCommand.mockImplementation(async (command) => command.args[0] === "-e" ? original(command) : commandResult(JSON.stringify({ success: true, testResults: [{ name: `${APP_BUILDER_ROOT}/src/app/[id]/route.test.ts`, assertionResults: [{ status: "passed" }] }] })));
    const result = await runBuilderCommand({ sandboxName: "test", command: "test_focused", paths: ["src/app/[id]/route.test.ts"] });
    expect(result).toMatchObject({ exitCode: 0, specification: { policySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(sandboxMocks.runCommand).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "node", args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", "./src/app/[id]/route.test.ts"], env: { NODE_ENV: "test", VERCEL: "", VERCEL_ENV: "" } }));
    await expect(runBuilderCommand({ sandboxName: "test", command: "test_focused", paths: ["missing.test.ts"] })).rejects.toThrow(/regular file/);
  });

  it("refuses empty, skipped, extra and malformed test evidence", async () => {
    const { parseBuilderFocusedTestSummary } = await import("@/lib/app-builder/sandbox");
    const paths = ["src/feature.test.ts"];
    const report = (name: string, statuses: string[]) => JSON.stringify({ success: true, testResults: [{ name: `${APP_BUILDER_ROOT}/${name}`, assertionResults: statuses.map((status) => ({ status })) }] });
    expect(parseBuilderFocusedTestSummary(report(paths[0], ["passed", "passed"]), paths)).toMatchObject({ totalTests: 2, passedTests: 2, success: true, executedPaths: paths });
    expect(parseBuilderFocusedTestSummary(report(paths[0], ["skipped"]), paths).success).toBe(false);
    expect(parseBuilderFocusedTestSummary(report(paths[0], ["failed"]), paths)).toMatchObject({ failedTests: 1, success: false });
    expect(() => parseBuilderFocusedTestSummary(report(paths[0], []), paths)).toThrow(/non-empty/);
    expect(() => parseBuilderFocusedTestSummary(report("src/other.test.ts", ["passed"]), paths)).toThrow(/unexpected/);
    expect(() => parseBuilderFocusedTestSummary("not JSON", paths)).toThrow(/JSON/);
  });

  it("bounds archive expansion and refuses links, devices and malformed listings", async () => {
    const { validateBuilderArchiveListing } = await import("@/lib/app-builder/sandbox");
    expect(validateBuilderArchiveListing("drwxr-xr-x root/root 0 2026-01-01 00:00 repo/\n-rwxr-xr-x root/root 32000000 2026-01-01 00:00 repo/script.ts\n")).toEqual({ entries: 2, byteCount: 32000000 });
    for (const prefix of ["lrwxrwxrwx", "hrw-r--r--", "crw-r--r--", "prw-r--r--"]) expect(() => validateBuilderArchiveListing(`${prefix} root/root 0 2026-01-01 00:00 repo/source`)).toThrow(/linked or special/);
    expect(() => validateBuilderArchiveListing("-rw-r--r-- root/root 536870913 2026-01-01 00:00 repo/huge")).toThrow(/expanded boundary/);
  });

  it("requires complete explicit worker credentials and otherwise retains OIDC", async () => {
    const { builderSandboxCredentials, listBuilderFiles } = await import("@/lib/app-builder/sandbox");
    for (const name of ["OMNIAGENT_SANDBOX_ACCESS_TOKEN", "OMNIAGENT_SANDBOX_TEAM_ID", "OMNIAGENT_SANDBOX_PROJECT_ID"]) vi.stubEnv(name, "");
    expect(builderSandboxCredentials()).toEqual({});
    vi.stubEnv("OMNIAGENT_SANDBOX_ACCESS_TOKEN", "synthetic-test-token");
    expect(() => builderSandboxCredentials()).toThrow(/together/);
    vi.stubEnv("OMNIAGENT_SANDBOX_TEAM_ID", "team_fixture");
    vi.stubEnv("OMNIAGENT_SANDBOX_PROJECT_ID", "prj_fixture");
    await listBuilderFiles("test");
    expect(sandboxMocks.get).toHaveBeenLastCalledWith({ name: "test", resume: true, token: "synthetic-test-token", teamId: "team_fixture", projectId: "prj_fixture" });
  });

  it("binds embedded previews to the validated Asael parent origin", async () => {
    const text = await readFile(new URL("./sandbox.ts", import.meta.url), "utf8");
    expect(text).toContain("ASAEL_PREVIEW_PARENT_ORIGIN");
    expect(text).toContain('delete responseHeaders["x-frame-options"]');
    expect(text).toContain('startsWith("frame-ancestors ")');
    expect(text).toContain('responseHeaders["referrer-policy"] = "no-referrer"');
    expect(text).toContain("builderPreviewParentOrigin()");
  });
});
