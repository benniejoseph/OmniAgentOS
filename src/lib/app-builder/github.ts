import "server-only";

import { createSign } from "node:crypto";
import type {
  AppBuilderFile,
  AppBuilderGithubStatus,
  AppBuilderRepository,
} from "@/lib/app-builder/contracts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_GITHUB_RESPONSE_BYTES = 2_000_000;
const GITHUB_DEADLINE_MS = 30_000;
const MAX_DELIVERY_FILES = 500;
const MAX_DELIVERY_BYTES = 8_000_000;

type GitHubAppConfig = Readonly<{
  appId: string;
  privateKey: string;
  installationId: string;
  repositoryIds: ReadonlySet<string>;
  appSlug?: string;
}>;

type InstallationToken = Readonly<{ token: string; expiresAt: string }>;

export type GitHubDeliveryResult = Readonly<{
  baseSha: string;
  commitSha: string;
  treeSha: string;
  branchName: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}>;

export class GitHubDeliveryPartialError extends Error {
  constructor(
    message: string,
    readonly partial: Readonly<{ branchName: string; commitSha: string }>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function getBuilderGithubStatus(): AppBuilderGithubStatus {
  const missing = [] as string[];
  if (!process.env.OMNIAGENT_GITHUB_APP_ID?.trim()) missing.push("GitHub App ID");
  if (!process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY?.trim()) missing.push("GitHub App private key");
  if (!process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID?.trim()) missing.push("GitHub App installation ID");
  if (!process.env.OMNIAGENT_GITHUB_APP_REPOSITORY_IDS?.trim()) missing.push("GitHub repository allowlist");
  const appSlug = process.env.OMNIAGENT_GITHUB_APP_SLUG?.trim() || undefined;
  return {
    configured: missing.length === 0,
    missing,
    appSlug,
    installUrl: appSlug ? `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` : undefined,
  };
}

export async function listBuilderGithubRepositories(): Promise<AppBuilderRepository[]> {
  const config = githubAppConfig();
  const token = await createInstallationToken();
  const repositories: AppBuilderRepository[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await githubRequest<{
      repositories?: Array<{
        id?: number;
        name?: string;
        full_name?: string;
        private?: boolean;
        default_branch?: string;
        html_url?: string;
        owner?: { login?: string };
      }>;
    }>(`/installation/repositories?per_page=100&page=${page}`, { token: token.token });
    const items = Array.isArray(response.repositories) ? response.repositories : [];
    for (const item of items) {
      if (
        !Number.isSafeInteger(item.id) ||
        !config.repositoryIds.has(String(item.id)) ||
        !item.name?.trim() ||
        !item.full_name?.trim() ||
        !item.owner?.login?.trim() ||
        !item.default_branch?.trim() ||
        !item.html_url?.startsWith("https://github.com/")
      ) continue;
      repositories.push({
        repositoryId: String(item.id),
        owner: item.owner.login,
        name: item.name,
        fullName: item.full_name,
        private: item.private === true,
        defaultBranch: item.default_branch,
        htmlUrl: item.html_url,
      });
    }
    if (items.length < 100) break;
  }
  return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export async function resolveBuilderGithubRepository(repositoryId: string) {
  const repository = (await listBuilderGithubRepositories()).find(
    (candidate) => candidate.repositoryId === repositoryId,
  );
  if (!repository) {
    throw new Error("The selected repository is not available to the configured GitHub App installation.");
  }
  const token = await createInstallationToken(repository.repositoryId);
  const baseSha = await getGithubBranchHead(repository, repository.defaultBranch, token.token);
  return { repository, baseSha };
}

export async function getBuilderGithubRepositoryHead(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  branch: string;
}) {
  const token = await createInstallationToken(input.repository.repositoryId);
  return getGithubBranchHead(input.repository, input.branch, token.token);
}

export async function deliverBuilderFilesToGithub(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  expectedBaseSha: string;
  defaultBranch: string;
  branchName: string;
  title: string;
  body: string;
  draft: boolean;
  files: readonly AppBuilderFile[];
}): Promise<GitHubDeliveryResult> {
  if (input.files.length < 1 || input.files.length > MAX_DELIVERY_FILES) {
    throw new Error(`GitHub delivery requires 1-${MAX_DELIVERY_FILES} bounded application files.`);
  }
  const byteCount = input.files.reduce((total, file) => total + file.size, 0);
  if (byteCount > MAX_DELIVERY_BYTES) {
    throw new Error("The application workspace exceeds the 8 MB reviewed GitHub delivery limit.");
  }
  const token = await createInstallationToken(input.repository.repositoryId);
  const currentBaseSha = await getGithubBranchHead(
    input.repository,
    input.defaultBranch,
    token.token,
  );
  if (currentBaseSha !== input.expectedBaseSha) {
    throw new Error("The repository default branch changed after it was bound. Refresh the repository binding before delivery.");
  }
  const existingBranch = await getGithubBranchHead(
    input.repository,
    input.branchName,
    token.token,
    true,
  );
  if (existingBranch) {
    throw new Error("That GitHub branch already exists. Choose a new branch name so no remote work is overwritten.");
  }

  const baseCommit = await githubRequest<{ tree?: { sha?: string } }>(
    repositoryPath(input.repository, `/git/commits/${encodeURIComponent(currentBaseSha)}`),
    { token: token.token },
  );
  const baseTreeSha = baseCommit.tree?.sha;
  if (!baseTreeSha || !/^[a-f0-9]{40,64}$/.test(baseTreeSha)) {
    throw new Error("GitHub did not return the exact base tree for this repository revision.");
  }

  const blobs = await mapWithConcurrency(input.files, 6, async (file) => {
    const blob = await githubRequest<{ sha?: string }>(
      repositoryPath(input.repository, "/git/blobs"),
      {
        token: token.token,
        method: "POST",
        body: { content: file.content, encoding: "utf-8" },
      },
    );
    if (!blob.sha || !/^[a-f0-9]{40,64}$/.test(blob.sha)) {
      throw new Error(`GitHub did not confirm the uploaded blob for ${file.path}.`);
    }
    return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
  });
  const tree = await githubRequest<{ sha?: string }>(
    repositoryPath(input.repository, "/git/trees"),
    {
      token: token.token,
      method: "POST",
      body: { base_tree: baseTreeSha, tree: blobs },
    },
  );
  if (!tree.sha || !/^[a-f0-9]{40,64}$/.test(tree.sha)) {
    throw new Error("GitHub did not confirm the generated application tree.");
  }
  const commit = await githubRequest<{ sha?: string }>(
    repositoryPath(input.repository, "/git/commits"),
    {
      token: token.token,
      method: "POST",
      body: { message: input.title, tree: tree.sha, parents: [currentBaseSha] },
    },
  );
  if (!commit.sha || !/^[a-f0-9]{40,64}$/.test(commit.sha)) {
    throw new Error("GitHub did not confirm the generated application commit.");
  }
  await githubRequest(
    repositoryPath(input.repository, "/git/refs"),
    {
      token: token.token,
      method: "POST",
      body: { ref: `refs/heads/${input.branchName}`, sha: commit.sha },
    },
  );
  let pull: { number?: number; html_url?: string };
  try {
    pull = await githubRequest<{ number?: number; html_url?: string }>(
      repositoryPath(input.repository, "/pulls"),
      {
        token: token.token,
        method: "POST",
        body: {
          title: input.title,
          body: input.body,
          head: input.branchName,
          base: input.defaultBranch,
          draft: input.draft,
        },
      },
    );
  } catch (error) {
    throw new GitHubDeliveryPartialError(
      "GitHub created the application branch but could not open its pull request. Review the recorded branch before starting a new attempt.",
      { branchName: input.branchName, commitSha: commit.sha },
      { cause: error },
    );
  }
  if (!Number.isSafeInteger(pull.number) || !pull.html_url?.startsWith("https://github.com/")) {
    throw new GitHubDeliveryPartialError(
      "GitHub created the application branch but did not confirm its pull request. Review the recorded branch before starting a new attempt.",
      { branchName: input.branchName, commitSha: commit.sha },
    );
  }
  return {
    baseSha: currentBaseSha,
    commitSha: commit.sha,
    treeSha: tree.sha,
    branchName: input.branchName,
    pullRequestNumber: pull.number as number,
    pullRequestUrl: pull.html_url,
  };
}

async function createInstallationToken(repositoryId?: string): Promise<InstallationToken> {
  const config = githubAppConfig();
  if (repositoryId && !config.repositoryIds.has(repositoryId)) {
    throw new Error("The selected repository is outside the configured GitHub App allowlist.");
  }
  const jwt = createAppJwt(config);
  await verifyGithubInstallation(config, jwt);
  const payload = repositoryId
    ? {
        repository_ids: [Number(repositoryId)],
        permissions: { contents: "write", pull_requests: "write", checks: "read" },
      }
    : undefined;
  const response = await githubRequest<{ token?: string; expires_at?: string }>(
    `/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    { token: jwt, method: "POST", body: payload },
  );
  if (!response.token || !response.expires_at) {
    throw new Error("GitHub App authentication did not return a bounded installation token.");
  }
  return { token: response.token, expiresAt: response.expires_at };
}

async function verifyGithubInstallation(config: GitHubAppConfig, jwt: string) {
  const installation = await githubRequest<{
    repository_selection?: string;
    permissions?: Record<string, string>;
    suspended_at?: string | null;
  }>(`/app/installations/${encodeURIComponent(config.installationId)}`, { token: jwt });
  if (installation.suspended_at) {
    throw new Error("The configured GitHub App installation is suspended.");
  }
  if (installation.repository_selection !== "selected") {
    throw new Error("The private GitHub App must be installed for selected repositories, not every repository.");
  }
  const permissions = installation.permissions || {};
  if (
    permissions.contents !== "write" ||
    permissions.pull_requests !== "write" ||
    !new Set(["read", "write"]).has(permissions.checks || "")
  ) {
    throw new Error("The GitHub App installation requires Contents and Pull requests write plus Checks read permission.");
  }
}

function githubAppConfig(): GitHubAppConfig {
  const status = getBuilderGithubStatus();
  if (!status.configured) {
    throw new Error(`GitHub App setup is incomplete: ${status.missing.join(", ")}.`);
  }
  const appId = process.env.OMNIAGENT_GITHUB_APP_ID!.trim();
  const installationId = process.env.OMNIAGENT_GITHUB_APP_INSTALLATION_ID!.trim();
  const repositoryIds = process.env.OMNIAGENT_GITHUB_APP_REPOSITORY_IDS!
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) {
    throw new Error("GitHub App and installation IDs must be numeric.");
  }
  if (
    repositoryIds.length < 1 ||
    repositoryIds.length > 100 ||
    repositoryIds.some((repositoryId) => !/^\d+$/.test(repositoryId))
  ) {
    throw new Error("GitHub repository allowlist must contain 1-100 comma-separated numeric repository IDs.");
  }
  return {
    appId,
    installationId,
    repositoryIds: new Set(repositoryIds),
    privateKey: process.env.OMNIAGENT_GITHUB_APP_PRIVATE_KEY!.replaceAll("\\n", "\n").trim(),
    appSlug: status.appSlug,
  };
}

function createAppJwt(config: GitHubAppConfig) {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: config.appId }));
  const unsigned = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
  } catch {
    throw new Error("The configured GitHub App private key is invalid.");
  }
}

async function getGithubBranchHead(
  repository: Pick<AppBuilderRepository, "owner" | "name">,
  branch: string,
  token: string,
  allowMissing = false,
) {
  try {
    const ref = await githubRequest<{ object?: { sha?: string } }>(
      repositoryPath(repository, `/git/ref/heads/${encodeURIComponent(branch)}`),
      { token },
    );
    const sha = ref.object?.sha;
    if (!sha || !/^[a-f0-9]{40,64}$/.test(sha)) {
      throw new Error("GitHub returned an invalid branch revision.");
    }
    return sha;
  } catch (error) {
    if (allowMissing && error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function githubRequest<T = Record<string, unknown>>(
  path: string,
  options: { token: string; method?: "GET" | "POST" | "PATCH"; body?: unknown },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_DEADLINE_MS);
  try {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method: options.method || "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "user-agent": "asael-app-builder",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > MAX_GITHUB_RESPONSE_BYTES) {
      throw new Error("GitHub returned an oversized response.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_GITHUB_RESPONSE_BYTES) {
      throw new Error("GitHub returned an oversized response.");
    }
    const parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) {
      const providerMessage = typeof parsed.message === "string" ? parsed.message.slice(0, 240) : "request failed";
      throw new GitHubApiError(response.status, `GitHub rejected the request (${response.status}: ${providerMessage}).`);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof GitHubApiError || error instanceof Error && error.message.startsWith("GitHub ")) throw error;
    if (controller.signal.aborted) throw new Error("GitHub did not respond before the delivery deadline.");
    throw new Error("GitHub could not be reached for this governed delivery operation.");
  } finally {
    clearTimeout(timeout);
  }
}

class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function repositoryPath(repository: Pick<AppBuilderRepository, "owner" | "name">, suffix: string) {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
) {
  const output = new Array<TOutput>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}
