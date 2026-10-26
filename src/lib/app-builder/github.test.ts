import { createHash, generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deliverBuilderFilesToGithub,
  downloadBuilderGithubRepositoryArchive,
  getBuilderGithubStatus,
  getBuilderGithubCommit,
  readBuilderGithubCandidateComparison,
  readBuilderGithubReleaseProof,
  readBuilderGithubNativeOnlyAdvance,
  GitHubDeliveryPartialError,
  listBuilderGithubRepositories,
  validateBuilderArchiveExpansion,
} from "@/lib/app-builder/github";

const original = {
  appId: process.env.OMNIAGENT_GITHUB_APP_ID,
  privateKey: process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY,
  installationId: process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID,
  repositoryIds: process.env.OMNIAGENT_GITHUB_APP_REPOSITORY_IDS,
  appSlug: process.env.OMNIAGENT_GITHUB_APP_SLUG,
};

describe("App Builder GitHub App broker", () => {
  beforeEach(() => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.OMNIAGENT_GITHUB_APP_ID = "12345";
    process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID = "67890";
    process.env.OMNIAGENT_GITHUB_APP_REPOSITORY_IDS = "42";
    process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.OMNIAGENT_GITHUB_APP_SLUG = "asael-private-builder";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore("OMNIAGENT_GITHUB_APP_ID", original.appId);
    restore("OMNIAGENT_GITHUB_APP_PRIVATE_KEY", original.privateKey);
    restore("OMNIAGENT_GITHUB_APP_INSTALLATION_ID", original.installationId);
    restore("OMNIAGENT_GITHUB_APP_REPOSITORY_IDS", original.repositoryIds);
    restore("OMNIAGENT_GITHUB_APP_SLUG", original.appSlug);
  });

  it("reports configuration without exposing credentials and lists only broker-allowlisted repositories", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ repositories: [
        {
          id: 41,
          name: "public-read-only",
          full_name: "benniejoseph/public-read-only",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/benniejoseph/public-read-only",
          owner: { login: "benniejoseph" },
        },
        {
          id: 42,
          name: "research-app",
          full_name: "benniejoseph/research-app",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/benniejoseph/research-app",
          owner: { login: "benniejoseph" },
        },
      ] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(getBuilderGithubStatus()).toEqual({
      configured: true,
      missing: [],
      appSlug: "asael-private-builder",
      installUrl: "https://github.com/apps/asael-private-builder/installations/new",
    });
    await expect(listBuilderGithubRepositories()).resolves.toEqual([expect.objectContaining({
      repositoryId: "42",
      fullName: "benniejoseph/research-app",
      private: true,
    })]);
    const tokenRequest = fetchMock.mock.calls[1];
    expect(String(tokenRequest[0])).toContain("/app/installations/67890/access_tokens");
    expect(String(tokenRequest[1].headers.authorization)).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(JSON.stringify(getBuilderGithubStatus())).not.toContain("PRIVATE KEY");
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer installation-token");
  });

  it("rejects a delivery repository outside the broker allowlist before provider access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverBuilderFilesToGithub({
      repository: { repositoryId: "41", owner: "benniejoseph", name: "public-read-only" },
      expectedBaseSha: "a".repeat(40),
      defaultBranch: "main",
      branchName: "asael/public-read-only-12345678",
      title: "Do not deliver",
      body: "Outside the explicit broker allowlist.",
      draft: true,
      changes: [{ kind: "upsert", file: { path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "c".repeat(64), size: 46 } }],
    })).rejects.toThrow(/outside the configured GitHub App allowlist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads an exact bounded archive without forwarding the installation token to codeload", async () => {
    const archive = gzipSync(Buffer.alloc(1024));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/benniejoseph/research-app/legacy.tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }))
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadBuilderGithubRepositoryArchive({
      repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" },
      baseSha: "a".repeat(40),
    })).resolves.toMatchObject({ byteCount: archive.byteLength });
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer installation-token");
    expect(fetchMock.mock.calls[3][1].headers.authorization).toBeUndefined();
  });

  it("bounds compressed downloads and streams expansion without accepting decompression bombs", async () => {
    const archive = gzipSync(Buffer.alloc(8192));
    await expect(validateBuilderArchiveExpansion(archive, 8192)).resolves.toBe(8192);
    await expect(validateBuilderArchiveExpansion(archive, 4096)).rejects.toThrow(/expanded boundary/);
    await expect(validateBuilderArchiveExpansion(new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid compressed/);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(new Response("", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadBuilderGithubRepositoryArchive({ repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" }, baseSha: "a".repeat(40) })).rejects.toThrow(/64 MiB/);
  });

  it("fences the exact base revision before creating any remote branch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ object: { sha: "b".repeat(40) } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverBuilderFilesToGithub({
      repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" },
      expectedBaseSha: "a".repeat(40),
      defaultBranch: "main",
      branchName: "asael/research-app-12345678",
      title: "Build research app",
      body: "Review evidence.",
      draft: true,
      changes: [{ kind: "upsert", file: { path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "c".repeat(64), size: 46 } }],
    })).rejects.toThrow(/default branch changed/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("creates blobs, one exact commit, a new branch, and a draft pull request", async () => {
    const baseSha = "a".repeat(40);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ object: { sha: baseSha } }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ tree: { sha: "b".repeat(40) } }))
      .mockResolvedValueOnce(jsonResponse({ sha: "c".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({ sha: "d".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({ sha: "e".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ number: 7, html_url: "https://github.com/benniejoseph/research-app/pull/7" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverBuilderFilesToGithub({
      repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" },
      expectedBaseSha: baseSha,
      defaultBranch: "main",
      branchName: "asael/research-app-12345678",
      title: "Build research app",
      body: "Review evidence.",
      draft: true,
      changes: [{ kind: "upsert", file: { path: "app/page.tsx", mode: "100755", content: "export default function Page() { return null }", sha256: "f".repeat(64), size: 46 } }],
    });

    expect(result).toEqual(expect.objectContaining({
      baseSha,
      commitSha: "e".repeat(40),
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/benniejoseph/research-app/pull/7",
    }));
    const tokenBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(tokenBody).toEqual({
      repository_ids: [42],
      permissions: { contents: "write", pull_requests: "write", checks: "read" },
    });
    const treeBody = JSON.parse(String(fetchMock.mock.calls[6][1].body));
    expect(treeBody.tree[0]).toMatchObject({ path: "app/page.tsx", mode: "100755" });
    const pullBody = JSON.parse(String(fetchMock.mock.calls[9][1].body));
    expect(pullBody).toMatchObject({ head: "asael/research-app-12345678", base: "main", draft: true });
  });

  it("reads exact candidate tree and measured GitHub diff counts", async () => {
    const base = "a".repeat(40), head = "b".repeat(40), tree = "c".repeat(40);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-10-26T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: base }, merge_base_commit: { sha: base }, commits: [{ sha: head }],
        files: [{ filename: "src/app/[id]/route.ts", status: "modified", additions: 7, deletions: 2, changes: 9 }] }))
      .mockResolvedValueOnce(jsonResponse({ sha: head, tree: { sha: tree }, parents: [{ sha: base }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readBuilderGithubCandidateComparison({ repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" }, baseSha: base, headSha: head })).resolves.toEqual({
      baseSha: base, headSha: head, headTreeSha: tree, changedLines: 9,
      files: [{ path: "src/app/[id]/route.ts", status: "modified", additions: 7, deletions: 2, changes: 9 }],
    });
  });

  it("refuses truncated comparisons and a commit lookup resolving another revision", async () => {
    const base = "a".repeat(40), head = "b".repeat(40), tree = "c".repeat(40);
    const repository = { repositoryId: "42", owner: "benniejoseph", name: "research-app" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-10-26T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, base_commit: { sha: base }, merge_base_commit: { sha: base }, commits: [{ sha: head }],
        files: Array.from({ length: 300 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 })) }))
      .mockResolvedValueOnce(jsonResponse({ sha: head, tree: { sha: tree }, parents: [{ sha: base }] }))
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-10-26T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ sha: base, tree: { sha: tree }, parents: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readBuilderGithubCandidateComparison({ repository, baseSha: base, headSha: head })).rejects.toThrow(/truncated/);
    await expect(getBuilderGithubCommit({ repository, revision: head })).rejects.toThrow(/exact commit/);
  });
  it("requires exact PR, source tree, squash parent and current main for release proof", async () => {
    const base = "a".repeat(40), source = "b".repeat(40), merged = "c".repeat(40), tree = "d".repeat(40);
    let changedTree = false, movedMain = false;
    const url = "https://github.com/benniejoseph/research-app/pull/9";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2026-10-26T05:00:00Z" });
      if (path.includes("/app/installations/")) return installationResponse();
      if (path.includes("/installation/repositories")) return jsonResponse({ repositories: [{ id: 42, name: "research-app", full_name: "benniejoseph/research-app", private: true, default_branch: "main", html_url: "https://github.com/benniejoseph/research-app", owner: { login: "benniejoseph" } }] });
      if (path.includes("/git/ref/heads/main")) return jsonResponse({ object: { sha: movedMain ? "e".repeat(40) : merged } });
      if (path.endsWith("/pulls/9")) return jsonResponse({ html_url: url, number: 9, state: "closed", draft: false, merged: true, merge_commit_sha: merged, head: { sha: source, repo: { id: 42 } }, base: { sha: merged, ref: "main", repo: { id: 42 } } });
      if (path.endsWith(`/git/commits/${source}`)) return jsonResponse({ sha: source, tree: { sha: tree }, parents: [{ sha: base }] });
      if (path.endsWith(`/git/commits/${merged}`)) return jsonResponse({ sha: merged, tree: { sha: changedTree ? "e".repeat(40) : tree }, parents: [{ sha: base }] });
      throw new Error("Unexpected provider request");
    }));
    const input = { repositoryId: "42", pullRequestUrl: url, sourceRevision: source, baseRevision: base, mergedRevision: merged };
    await expect(readBuilderGithubReleaseProof(input)).resolves.toMatchObject({ sourceTree: tree, defaultBranchHead: merged, mergedCommit: { sha: merged, treeSha: tree, parents: [base] } });
    changedTree = true; await expect(readBuilderGithubReleaseProof(input)).rejects.toThrow(/Merged source/);
    changedTree = false; movedMain = true; await expect(readBuilderGithubReleaseProof(input)).rejects.toThrow(/Merged source/);
    await expect(readBuilderGithubReleaseProof({ ...input, pullRequestUrl: "https://github.com/other/repository/pull/9" })).rejects.toThrow(/outside/);
  });

  describe("native-only source advance", () => {
    const serving = "a".repeat(40), source = "b".repeat(40), servingTree = "c".repeat(40), sourceTree = "d".repeat(40);
    const nativePath = "apps/flutter/lib/features/studio/canvas.dart";
    const input = { repositoryId: "42", repository: { owner: "benniejoseph", name: "research-app", defaultBranch: "main" }, servingRevision: serving, sourceBaseRevision: source };
    type Entry = { path: string; sha: string; type: string; mode: string };
    function tree(leaves: Entry[]) {
      const directories = new Set<string>();
      for (const entry of leaves) {
        const segments = entry.path.split("/");
        for (let length = 1; length < segments.length; length += 1) directories.add(segments.slice(0, length).join("/"));
      }
      return [...leaves, ...[...directories].map(path => ({ path, type: "tree", mode: "040000", sha: createHash("sha1").update(JSON.stringify(leaves.filter(entry => entry.path.startsWith(`${path}/`)))).digest("hex") }))];
    }
    function installFixture(options: {
      before?: Entry[]; after?: Entry[]; comparison?: object; truncated?: boolean; duplicate?: boolean; missingParent?: boolean; treeSha?: string; commitSha?: string; oversized?: boolean;
    } = {}) {
      const before = options.before ?? [{ path: nativePath, type: "blob", mode: "100644", sha: "e".repeat(40) }];
      const after = options.after ?? [{ ...before[0], sha: "f".repeat(40) }];
      const fetchMock = vi.fn(async (request: string | URL | Request) => {
        const path = String(request);
        if (path.endsWith("/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2026-10-27T05:00:00Z" });
        if (path.includes("/app/installations/")) return installationResponse();
        if (path.includes("/installation/repositories")) return jsonResponse({ repositories: [{ id: 42, name: "research-app", full_name: "benniejoseph/research-app", private: true, default_branch: "main", html_url: "https://github.com/benniejoseph/research-app", owner: { login: "benniejoseph" } }] });
        if (path.includes("/compare/")) return jsonResponse({ status: "ahead", ahead_by: 4, behind_by: 0, total_commits: 4, base_commit: { sha: serving }, merge_base_commit: { sha: serving }, files: [{ filename: nativePath }], ...options.comparison });
        if (path.endsWith(`/git/commits/${serving}`)) return jsonResponse({ sha: serving, tree: { sha: servingTree }, parents: [] });
        if (path.endsWith(`/git/commits/${source}`)) return jsonResponse({ sha: options.commitSha ?? source, tree: { sha: sourceTree }, parents: [{ sha: serving }] });
        if (path.includes(`/git/trees/${servingTree}`)) return jsonResponse({ sha: servingTree, truncated: false, tree: tree(before) });
        if (path.includes(`/git/trees/${sourceTree}`)) {
          if (options.oversized) return new Response("", { headers: { "content-length": String(7 * 1024 * 1024 + 1) } });
          let entries = tree(after);
          if (options.duplicate) entries = [...entries, entries[0]];
          if (options.missingParent) entries = entries.filter(entry => entry.path !== "apps/flutter/lib");
          return jsonResponse({ sha: options.treeSha ?? sourceTree, truncated: options.truncated ?? false, tree: entries });
        }
        throw new Error("Unexpected provider request");
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("binds immutable complete trees while main may already contain a later merged candidate", async () => {
      const fetchMock = installFixture();
      const proof = await readBuilderGithubNativeOnlyAdvance(input);
      expect(proof).toMatchObject({ servingRevision: serving, sourceBaseRevision: source, servingTree, sourceTree, changedPaths: [nativePath], proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/git/ref/heads/"))).toBe(true);
    });

    it("checks every changed leaf even when compare's file list omits a server change", async () => {
      installFixture({ after: [{ path: nativePath, type: "blob", mode: "100644", sha: "f".repeat(40) }, { path: "src/app/api/auth/route.ts", type: "blob", mode: "100644", sha: "1".repeat(40) }] });
      await expect(readBuilderGithubNativeOnlyAdvance(input)).rejects.toThrow(/ineligible path/);
    });

    it("checks removed paths instead of accepting a protected file renamed into a native feature", async () => {
      installFixture({ before: [{ path: "src/lib/auth.ts", type: "blob", mode: "100644", sha: "e".repeat(40) }], after: [{ path: nativePath, type: "blob", mode: "100644", sha: "e".repeat(40) }] });
      await expect(readBuilderGithubNativeOnlyAdvance(input)).rejects.toThrow(/ineligible path/);
    });

    it("uses complete trees beyond the comparison endpoint's 300-file boundary", async () => {
      const leaves = Array.from({ length: 301 }, (_, index) => ({ path: `apps/flutter/lib/features/studio/file_${index}.dart`, type: "blob", mode: "100644", sha: "e".repeat(40) }));
      installFixture({ before: leaves, after: leaves.map(entry => ({ ...entry, sha: "f".repeat(40) })) });
      await expect(readBuilderGithubNativeOnlyAdvance(input)).resolves.toMatchObject({ changedPaths: expect.arrayContaining([leaves[300].path]) });
    });

    it.each([
      { mode: "120000", type: "blob" },
      { mode: "160000", type: "commit" },
      { mode: "100755", type: "blob" },
    ])("rejects a changed symlink, submodule or executable mode: $mode", async entry => {
      installFixture({ after: [{ path: nativePath, sha: "f".repeat(40), ...entry }] });
      await expect(readBuilderGithubNativeOnlyAdvance(input)).rejects.toThrow(/ineligible path or file mode/);
    });

    it.each([
      { truncated: true }, { duplicate: true }, { missingParent: true }, { treeSha: "9".repeat(40) }, { commitSha: "9".repeat(40) }, { oversized: true },
      { comparison: { status: "diverged", behind_by: 1 } }, { comparison: { merge_base_commit: { sha: "9".repeat(40) } } },
    ])("rejects incomplete or mismatched provider evidence %j", async options => {
      installFixture(options);
      await expect(readBuilderGithubNativeOnlyAdvance(input)).rejects.toThrow(/GitHub/);
    });

    it("rejects an empty delta and a different configured repository or branch", async () => {
      const leaf = { path: nativePath, type: "blob", mode: "100644", sha: "e".repeat(40) };
      installFixture({ before: [leaf], after: [leaf] });
      await expect(readBuilderGithubNativeOnlyAdvance(input)).rejects.toThrow(/empty/);
      await expect(readBuilderGithubNativeOnlyAdvance({ ...input, repository: { ...input.repository, name: "elsewhere" } })).rejects.toThrow(/selected repository/);
      await expect(readBuilderGithubNativeOnlyAdvance({ ...input, repository: { ...input.repository, defaultBranch: "other" } })).rejects.toThrow(/selected repository/);
    });
  });

  it("returns a partial-effect receipt when the branch exists but pull-request creation fails", async () => {
    const baseSha = "a".repeat(40);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ object: { sha: baseSha } }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ tree: { sha: "b".repeat(40) } }))
      .mockResolvedValueOnce(jsonResponse({ sha: "c".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({ sha: "d".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({ sha: "e".repeat(40) }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ message: "Validation Failed" }, 422));
    vi.stubGlobal("fetch", fetchMock);

    const error = await deliverBuilderFilesToGithub({
      repository: { repositoryId: "42", owner: "benniejoseph", name: "research-app" },
      expectedBaseSha: baseSha,
      defaultBranch: "main",
      branchName: "asael/research-app-partial",
      title: "Build research app",
      body: "Review evidence.",
      draft: true,
      changes: [{ kind: "upsert", file: { path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "f".repeat(64), size: 46 } }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubDeliveryPartialError);
    expect((error as GitHubDeliveryPartialError).partial).toEqual({
      branchName: "asael/research-app-partial",
      commitSha: "e".repeat(40),
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installationResponse() {
  return jsonResponse({
    repository_selection: "selected",
    permissions: { contents: "write", pull_requests: "write", checks: "read" },
    suspended_at: null,
  });
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
