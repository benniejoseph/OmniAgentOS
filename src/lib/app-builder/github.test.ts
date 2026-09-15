import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deliverBuilderFilesToGithub,
  getBuilderGithubStatus,
  GitHubDeliveryPartialError,
  listBuilderGithubRepositories,
} from "@/lib/app-builder/github";

const original = {
  appId: process.env.OMNIAGENT_GITHUB_APP_ID,
  privateKey: process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY,
  installationId: process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID,
  appSlug: process.env.OMNIAGENT_GITHUB_APP_SLUG,
};

describe("App Builder GitHub App broker", () => {
  beforeEach(() => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.OMNIAGENT_GITHUB_APP_ID = "12345";
    process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID = "67890";
    process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.OMNIAGENT_GITHUB_APP_SLUG = "asael-private-builder";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore("OMNIAGENT_GITHUB_APP_ID", original.appId);
    restore("OMNIAGENT_GITHUB_APP_PRIVATE_KEY", original.privateKey);
    restore("OMNIAGENT_GITHUB_APP_INSTALLATION_ID", original.installationId);
    restore("OMNIAGENT_GITHUB_APP_SLUG", original.appSlug);
  });

  it("reports configuration without exposing credential material and lists only installation repositories", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(jsonResponse({ token: "installation-token", expires_at: "2026-09-15T05:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ repositories: [{
        id: 42,
        name: "research-app",
        full_name: "benniejoseph/research-app",
        private: true,
        default_branch: "main",
        html_url: "https://github.com/benniejoseph/research-app",
        owner: { login: "benniejoseph" },
      }] }));
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
      files: [{ path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "c".repeat(64), size: 46 }],
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
      files: [{ path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "f".repeat(64), size: 46 }],
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
    const pullBody = JSON.parse(String(fetchMock.mock.calls[9][1].body));
    expect(pullBody).toMatchObject({ head: "asael/research-app-12345678", base: "main", draft: true });
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
      files: [{ path: "app/page.tsx", content: "export default function Page() { return null }", sha256: "f".repeat(64), size: 46 }],
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
