import "server-only";

import { createHash, createSign } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { readResponseTextLimited } from "@/lib/http/body";
import { isSelfImprovementNativePath, selfImprovementNativeSha } from "@/lib/self-improvement/native-contracts";
import { APP_BUILDER_MAX_ARCHIVE_BYTES, APP_BUILDER_MAX_EXPANDED_BYTES, safeBuilderRelativePath } from "@/lib/app-builder/contracts";
import type {
  AppBuilderDeliveryChange,
  AppBuilderGithubStatus,
  AppBuilderRepository,
} from "@/lib/app-builder/contracts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_GITHUB_RESPONSE_BYTES = 2_000_000;
const MAX_GITHUB_TREE_RESPONSE_BYTES = 7 * 1024 * 1024;
const GITHUB_DEADLINE_MS = 30_000;
const MAX_DELIVERY_FILES = 500;
const MAX_DELIVERY_BYTES = 8_000_000;
const MAX_REPOSITORY_ARCHIVE_BYTES = APP_BUILDER_MAX_ARCHIVE_BYTES;
const GITHUB_ARCHIVE_DEADLINE_MS = 90_000;

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

export async function getBuilderGithubCommit(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  revision: string;
}) {
  if (!/^[a-f0-9]{40,64}$/.test(input.revision)) throw new Error("GitHub commit lookup requires an exact revision.");
  const token = await createInstallationToken(input.repository.repositoryId);
  return readExactCommit(input.repository, input.revision, token.token);
}

/** Read-only provider evidence for the trusted Asael release controller. */
export async function readBuilderGithubReleaseProof(input: {
  repositoryId: string; pullRequestUrl: string; sourceRevision: string; baseRevision: string; mergedRevision?: string;
}) {
  if (![input.sourceRevision, input.baseRevision, ...(input.mergedRevision ? [input.mergedRevision] : [])].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Release proof requires exact Git revisions.");
  const { repository } = await resolveBuilderGithubRepository(input.repositoryId);
  const url = new URL(input.pullRequestUrl);
  const prefix = `/${repository.owner}/${repository.name}/pull/`;
  if (url.origin !== "https://github.com" || url.search || url.hash || url.username || url.password || !url.pathname.startsWith(prefix) || !/^[1-9][0-9]{0,11}$/.test(url.pathname.slice(prefix.length))) throw new Error("Release pull request is outside the selected repository.");
  const number = Number(url.pathname.slice(prefix.length)), token = (await createInstallationToken(repository.repositoryId)).token;
  const [pull, source, defaultBranchHead, merged] = await Promise.all([
    githubRequest<{ html_url?: string; number?: number; state?: string; draft?: boolean; merged?: boolean; merge_commit_sha?: string | null; head?: { sha?: string; repo?: { id?: number } }; base?: { sha?: string; ref?: string; repo?: { id?: number } } }>(repositoryPath(repository, `/pulls/${number}`), { token }),
    readExactCommit(repository, input.sourceRevision, token),
    getGithubBranchHead(repository, repository.defaultBranch, token),
    input.mergedRevision ? readExactCommit(repository, input.mergedRevision, token) : Promise.resolve(null),
  ]);
  if (pull.html_url !== input.pullRequestUrl || pull.number !== number || String(pull.base?.repo?.id) !== repository.repositoryId || String(pull.head?.repo?.id) !== repository.repositoryId ||
      pull.head?.sha !== input.sourceRevision || pull.base?.ref !== repository.defaultBranch || !/^[a-f0-9]{40}$/.test(pull.base?.sha || "") ||
      !["open", "closed"].includes(pull.state || "") || typeof pull.draft !== "boolean" || typeof pull.merged !== "boolean") throw new Error("GitHub did not confirm the exact source pull request and repository.");
  if (merged && (pull.merged !== true || pull.merge_commit_sha !== input.mergedRevision || defaultBranchHead !== input.mergedRevision ||
      merged.parents.length !== 1 || merged.parents[0] !== input.baseRevision || merged.treeSha !== source.treeSha)) throw new Error("Merged source, parent, tree or latest default branch no longer matches the verified candidate.");
  if (!merged && (pull.state !== "open" || pull.merged || pull.base.sha !== input.baseRevision || defaultBranchHead !== input.baseRevision)) throw new Error("The unmerged candidate no longer targets the exact current base.");
  return { repository, defaultBranchHead, sourceRevision: source.sha, sourceTree: source.treeSha,
    pullRequest: { url: pull.html_url, number, state: pull.state, draft: pull.draft, merged: pull.merged, headSha: pull.head.sha, baseSha: pull.base.sha, baseRef: pull.base.ref, mergeCommitSha: pull.merge_commit_sha || null }, mergedCommit: merged };
}

async function readExactCommit(repository: Pick<AppBuilderRepository, "owner" | "name">, revision: string, token: string) {
  const commit = await githubRequest<{ sha?: string; tree?: { sha?: string }; parents?: Array<{ sha?: string }> }>(
    repositoryPath(repository, `/git/commits/${encodeURIComponent(revision)}`), { token },
  );
  if (commit.sha !== revision || !/^[a-f0-9]{40,64}$/.test(commit.tree?.sha || "") ||
      !Array.isArray(commit.parents) || commit.parents.length > 16 || commit.parents.some((parent) => !/^[a-f0-9]{40,64}$/.test(parent.sha || ""))) {
    throw new Error("GitHub did not confirm the exact commit, source tree and parents.");
  }
  return { sha: commit.sha, treeSha: commit.tree!.sha!, parents: commit.parents.map((parent) => parent.sha!) };
}

/** Prove a Mac-only advance without deploying the unchanged server pair. */
export async function readBuilderGithubNativeOnlyAdvance(input: {
  repositoryId: string;
  repository: Pick<AppBuilderRepository, "owner" | "name" | "defaultBranch">;
  servingRevision: string;
  sourceBaseRevision: string;
}) {
  if (![input.servingRevision, input.sourceBaseRevision].every(sha => /^[a-f0-9]{40}$/.test(sha)) || input.servingRevision === input.sourceBaseRevision) {
    throw new Error("GitHub native-only advance requires distinct exact revisions.");
  }
  const repository = (await listBuilderGithubRepositories()).find(item => item.repositoryId === input.repositoryId);
  if (!repository || repository.owner !== input.repository.owner || repository.name !== input.repository.name || repository.defaultBranch !== input.repository.defaultBranch) {
    throw new Error("GitHub native-only advance is outside the selected repository and branch.");
  }
  const token = (await createInstallationToken(repository.repositoryId)).token;
  const [comparison, serving, source] = await Promise.all([
    githubRequest<{ status?: string; ahead_by?: number; behind_by?: number; total_commits?: number; base_commit?: { sha?: string }; merge_base_commit?: { sha?: string } }>(
      repositoryPath(repository, `/compare/${input.servingRevision}...${input.sourceBaseRevision}?per_page=1`), { token },
    ),
    readExactCommit(repository, input.servingRevision, token),
    readExactCommit(repository, input.sourceBaseRevision, token),
  ]);
  if (comparison.status !== "ahead" || comparison.behind_by !== 0 || comparison.base_commit?.sha !== input.servingRevision || comparison.merge_base_commit?.sha !== input.servingRevision ||
      !Number.isSafeInteger(comparison.total_commits) || Number(comparison.total_commits) < 1 || comparison.ahead_by !== comparison.total_commits) {
    throw new Error("GitHub native-only advance does not descend from the exact serving revision.");
  }
  // Compare complete trees: the compare endpoint's file list is capped at 300.
  const [before, after] = await Promise.all([
    readCompleteGithubTree(repository, serving.treeSha, token),
    readCompleteGithubTree(repository, source.treeSha, token),
  ]);
  const changedPaths: string[] = [];
  const changedDirectories: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldEntry = before.get(path), newEntry = after.get(path);
    if (oldEntry?.sha === newEntry?.sha && oldEntry?.mode === newEntry?.mode && oldEntry?.type === newEntry?.type) continue;
    if ((!oldEntry || oldEntry.type === "tree") && (!newEntry || newEntry.type === "tree")) {
      changedDirectories.push(path);
      continue;
    }
    if (!isSelfImprovementNativePath(path) || [oldEntry, newEntry].some(entry => entry && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) ||
        (oldEntry && newEntry && oldEntry.mode !== newEntry.mode)) {
      throw new Error("GitHub native-only advance includes an ineligible path or file mode.");
    }
    changedPaths.push(path);
  }
  if (!changedPaths.length || changedDirectories.some(directory => !changedPaths.some(path => path.startsWith(`${directory}/`)))) {
    throw new Error("GitHub native-only advance is empty or its complete tree evidence is inconsistent.");
  }
  const proof = { servingRevision: input.servingRevision, sourceBaseRevision: input.sourceBaseRevision,
    servingTree: serving.treeSha, sourceTree: source.treeSha, changedPaths };
  return { ...proof, proofSha256: selfImprovementNativeSha("native_only_source_advance", {
    repositoryId: repository.repositoryId, repository: input.repository, ...proof,
  }) };
}

type GithubTreeEntry = { path: string; type: "tree" | "blob" | "commit"; mode: string; sha: string };

async function readCompleteGithubTree(repository: Pick<AppBuilderRepository, "owner" | "name">, treeSha: string, token: string) {
  const response = await githubRequest<{ sha?: string; truncated?: boolean; tree?: GithubTreeEntry[] }>(
    repositoryPath(repository, `/git/trees/${treeSha}?recursive=1`), { token, maxResponseBytes: MAX_GITHUB_TREE_RESPONSE_BYTES },
  );
  if (response.sha !== treeSha || response.truncated !== false || !Array.isArray(response.tree) || !response.tree.length || response.tree.length > 100_000) {
    throw new Error("GitHub native-only advance requires complete, untruncated exact trees.");
  }
  const entries = new Map<string, GithubTreeEntry>();
  for (const entry of response.tree) {
    if (!entry || typeof entry.path !== "string" || entry.path.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(entry.path) || entry.path.split("/").some(part => !part || part === "." || part === "..") ||
        !/^[a-f0-9]{40}$/.test(entry.sha) || entries.has(entry.path) ||
        !(entry.type === "tree" && entry.mode === "040000" || entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode) || entry.type === "commit" && entry.mode === "160000")) {
      throw new Error("GitHub native-only advance tree entries are invalid or duplicated.");
    }
    entries.set(entry.path, entry);
  }
  for (const path of entries.keys()) {
    const separator = path.lastIndexOf("/");
    if (separator !== -1 && entries.get(path.slice(0, separator))?.type !== "tree") {
      throw new Error("GitHub native-only advance tree is missing a parent directory.");
    }
  }
  return entries;
}

export async function readBuilderGithubCandidateComparison(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  baseSha: string;
  headSha: string;
}) {
  if (![input.baseSha, input.headSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || input.baseSha === input.headSha) {
    throw new Error("GitHub comparison requires distinct exact base and candidate revisions.");
  }
  const token = await createInstallationToken(input.repository.repositoryId);
  const [comparison, head] = await Promise.all([
    githubRequest<{ status?: string; ahead_by?: number; behind_by?: number; total_commits?: number; base_commit?: { sha?: string }; merge_base_commit?: { sha?: string }; commits?: Array<{ sha?: string }>; files?: Array<{ filename?: string; previous_filename?: string; status?: string; additions?: number; deletions?: number; changes?: number }> }>(
      repositoryPath(input.repository, `/compare/${input.baseSha}...${input.headSha}?per_page=100`), { token: token.token },
    ),
    readExactCommit(input.repository, input.headSha, token.token),
  ]);
  if (comparison.status !== "ahead" || comparison.behind_by !== 0 || comparison.base_commit?.sha !== input.baseSha || comparison.merge_base_commit?.sha !== input.baseSha ||
      !Number.isSafeInteger(comparison.total_commits) || !Array.isArray(comparison.commits) || !comparison.commits.length ||
      comparison.total_commits !== comparison.commits.length || comparison.ahead_by !== comparison.total_commits || comparison.commits.at(-1)?.sha !== input.headSha ||
      !Array.isArray(comparison.files) || !comparison.files.length || comparison.files.length >= 300) {
    throw new Error("GitHub candidate comparison is divergent, empty, truncated or not bound to the exact revisions.");
  }
  const seen = new Set<string>();
  const files = comparison.files.map((file) => {
    const path = safeBuilderRelativePath(file.filename || "");
    if (seen.has(path) || !["added", "removed", "modified", "renamed", "copied", "changed"].includes(file.status || "") ||
        ![file.additions, file.deletions, file.changes].every((count) => Number.isSafeInteger(count) && Number(count) >= 0) || file.changes !== Number(file.additions) + Number(file.deletions)) {
      throw new Error("GitHub candidate file comparison is incomplete or inconsistent.");
    }
    seen.add(path);
    const previousPath = file.previous_filename ? safeBuilderRelativePath(file.previous_filename) : undefined;
    if (file.status === "renamed" && !previousPath) throw new Error("GitHub candidate rename is missing its previous path.");
    return { path, status: file.status!, additions: file.additions!, deletions: file.deletions!, changes: file.changes!, ...(previousPath ? { previousPath } : {}) };
  });
  const changedLines = files.reduce((total, file) => total + file.changes, 0);
  if (!Number.isSafeInteger(changedLines)) throw new Error("GitHub candidate line count is outside its numeric boundary.");
  return { baseSha: input.baseSha, headSha: input.headSha, headTreeSha: head.treeSha, changedLines, files };
}

export async function downloadBuilderGithubRepositoryArchive(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  baseSha: string;
}) {
  if (!/^[a-f0-9]{40,64}$/.test(input.baseSha)) {
    throw new Error("Repository checkout requires an exact GitHub commit revision.");
  }
  const token = await createInstallationToken(input.repository.repositoryId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_ARCHIVE_DEADLINE_MS);
  try {
    const initial = await fetch(
      `${GITHUB_API}${repositoryPath(input.repository, `/tarball/${encodeURIComponent(input.baseSha)}`)}`,
      {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token.token}`,
          "user-agent": "asael-app-builder",
          "x-github-api-version": GITHUB_API_VERSION,
        },
      },
    );
    let response = initial;
    if (new Set([301, 302, 303, 307, 308]).has(initial.status)) {
      const location = initial.headers.get("location");
      if (!location) throw new Error("GitHub did not provide its repository archive location.");
      const redirect = new URL(location, GITHUB_API);
      if (redirect.protocol !== "https:" || redirect.hostname !== "codeload.github.com") {
        throw new Error("GitHub returned an untrusted repository archive location.");
      }
      response = await fetch(redirect, {
        redirect: "error",
        signal: controller.signal,
        headers: { "user-agent": "asael-app-builder" },
      });
    }
    if (!response.ok) {
      throw new Error(`GitHub could not prepare the exact repository archive (${response.status}).`);
    }
    const archive = await readBoundedBytes(response, MAX_REPOSITORY_ARCHIVE_BYTES);
    if (archive.byteLength < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new Error("GitHub returned an invalid repository archive.");
    }
    await validateBuilderArchiveExpansion(archive);
    return {
      archive,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      byteCount: archive.byteLength,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("GitHub did not prepare the repository archive before the checkout deadline.");
    }
    if (error instanceof Error && error.message.startsWith("GitHub ")) throw error;
    throw new Error("GitHub could not be reached for this governed repository checkout.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverBuilderFilesToGithub(input: {
  repository: Pick<AppBuilderRepository, "repositoryId" | "owner" | "name">;
  expectedBaseSha: string;
  defaultBranch: string;
  branchName: string;
  title: string;
  body: string;
  draft: boolean;
  changes: readonly AppBuilderDeliveryChange[];
}): Promise<GitHubDeliveryResult> {
  if (input.changes.length < 1 || input.changes.length > MAX_DELIVERY_FILES) {
    throw new Error(`GitHub delivery requires 1-${MAX_DELIVERY_FILES} bounded application changes.`);
  }
  const seen = new Set<string>();
  const byteCount = input.changes.reduce((total, change) => {
    const path = safeBuilderRelativePath(change.kind === "upsert" ? change.file.path : change.path);
    if (seen.has(path)) throw new Error("GitHub delivery contains duplicate source paths.");
    seen.add(path);
    if (change.kind === "delete") return total;
    if (change.file.lineRange?.truncated || (change.file.mode !== undefined && !["100644", "100755"].includes(change.file.mode))) {
      throw new Error("GitHub delivery requires complete source contents and regular file modes.");
    }
    return total + Buffer.byteLength(change.file.content, "utf8");
  }, 0);
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

  const blobs = await mapWithConcurrency(input.changes, 6, async (change) => {
    if (change.kind === "delete") {
      return { path: change.path, mode: "100644", type: "blob", sha: null };
    }
    const file = change.file;
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
    return { path: file.path, mode: file.mode || "100644", type: "blob", sha: blob.sha };
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

/** Count decompressed bytes without buffering the expanded archive or writing it to disk. */
export async function validateBuilderArchiveExpansion(archive: Uint8Array, maximumBytes = APP_BUILDER_MAX_EXPANDED_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > APP_BUILDER_MAX_EXPANDED_BYTES || archive.byteLength > APP_BUILDER_MAX_ARCHIVE_BYTES) {
    throw new Error("GitHub repository archive exceeds the configured compressed or expanded boundary.");
  }
  const expanded = Readable.from([archive]).pipe(createGunzip());
  let byteCount = 0;
  try {
    for await (const chunk of expanded) {
      byteCount += (chunk as Buffer).byteLength;
      if (byteCount > maximumBytes) throw new Error("GitHub repository archive exceeds the 512 MiB expanded boundary.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub ")) throw error;
    throw new Error("GitHub returned an invalid compressed repository archive.");
  } finally {
    expanded.destroy();
  }
  return byteCount;
}

async function readBoundedBytes(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("GitHub repository archive exceeds the 64 MiB checkout boundary.");
  if (!response.body) throw new Error("GitHub repository archive response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("GitHub repository archive exceeds the 64 MiB checkout boundary.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
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
  options: { token: string; method?: "GET" | "POST" | "PATCH"; body?: unknown; maxResponseBytes?: number },
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
    const maxResponseBytes = options.maxResponseBytes ?? MAX_GITHUB_RESPONSE_BYTES;
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > maxResponseBytes) {
      throw new Error("GitHub returned an oversized response.");
    }
    const { text, truncated } = await readResponseTextLimited(response, maxResponseBytes);
    if (truncated) {
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
