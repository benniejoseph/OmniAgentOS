import type { BuilderFile, BuilderRelease, SessionPayload } from "./model";

export type BuilderSelection = Readonly<{
  view: "preview" | "code";
  rail: "files" | "checkpoints" | "activity";
  file: string;
  deployment: string;
  release: string;
  verification: string;
}>;
const prefixes = { deployment: "app_build_deployment_", release: "app_build_release_", verification: "app_build_verification_" } as const;
export function validSelectionId(kind: keyof typeof prefixes, value: string) {
  return new RegExp(`^${prefixes[kind]}[a-f0-9]{48}$`).test(value);
}
export function readBuilderSelection(search: string, projectId?: string): BuilderSelection {
  const params = new URLSearchParams(search);
  if (projectId && params.get("builderProject") && params.get("builderProject") !== projectId) return { view: "preview", rail: "files", file: "", deployment: "", release: "", verification: "" };
  const file = params.get("builderFile") || "";
  const identity = (kind: keyof typeof prefixes) => {
    const value = params.get(`builder${kind[0].toUpperCase()}${kind.slice(1)}`) || "";
    // An invalid explicit identity must stay visibly unresolved, never select another row.
    return value ? validSelectionId(kind, value) ? value : "invalid-selection" : "";
  };
  return { view: params.get("builderView") === "code" ? "code" : "preview",
    rail: params.get("builderRail") === "checkpoints" ? "checkpoints" : params.get("builderRail") === "activity" ? "activity" : "files",
    file: file && file.length <= 240 && !file.startsWith("/") && !file.split("/").includes("..") ? file : "",
    deployment: identity("deployment"), release: identity("release"), verification: identity("verification") };
}
export function builderSelectionUrl(href: string, selection: BuilderSelection, projectId?: string) {
  const url = new URL(href);
  if (projectId) url.searchParams.set("builderProject", projectId);
  for (const [key, value] of Object.entries(selection)) {
    const name = `builder${key[0].toUpperCase()}${key.slice(1)}`;
    if (value) url.searchParams.set(name, value); else url.searchParams.delete(name);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
/** Empty means choose the initial row once. Missing explicit choices are never substituted. */
export function exactSelection<T extends { id: string }>(rows: readonly T[], id: string) {
  return id ? rows.find((row) => row.id === id) : rows[0];
}
export function releaseConfirmationBasis(sessionId: string, release?: BuilderRelease) {
  return release ? JSON.stringify([sessionId, release.id, release.deploymentId, release.releaseDigest, release.expiresAt, release.status]) : "";
}
export function canConfirmRelease(release: BuilderRelease, now: number) {
  return Number.isFinite(Date.parse(release.expiresAt)) && Date.parse(release.expiresAt) > now &&
    release.migrationEvidence.status === "not_declared" &&
    (release.status === "review_pending" || release.status === "releasing" && !release.providerDeploymentId);
}
export function safeExternalUrl(value?: string | null) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function isolatedPreviewUrl(value: string | null, appOrigin: string) {
  const safe = safeExternalUrl(value);
  return safe && appOrigin && new URL(safe).origin !== appOrigin ? safe : undefined;
}
export function assertSnapshotIdentity(payload: SessionPayload, projectId: string) {
  if (!payload || typeof payload !== "object" || payload.session && (payload.session.projectId !== projectId || !/^app_build_[a-f0-9]{48}$/.test(payload.session.id))) throw new Error("Builder returned a different project or invalid session.");
  const limits = { activity: 40, checkpoints: 20, verifications: 10, deliveries: 20, deployments: 20, releases: 20 } as const;
  for (const [key, limit] of Object.entries(limits)) {
    const rows = payload[key as keyof typeof limits];
    if (!Array.isArray(rows) || rows.length > limit || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Builder returned an invalid bounded history.");
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || "sessionId" in row && row.sessionId !== payload.session?.id || "projectId" in row && row.projectId !== projectId) throw new Error("Builder history does not belong to the selected workspace.");
    }
  }
  return payload;
}
export function assertExactFile(file: BuilderFile, path: string) {
  if (!file || file.path !== path || typeof file.content !== "string" || file.content.length > 500_000 || !/^[a-f0-9]{64}$/.test(file.sha256) || file.lineRange?.truncated) throw new Error("The complete exact file could not be loaded. Editing remains unavailable.");
  return file;
}
export function boundedOutput(value: string) { return value.length <= 64_000 ? value : `[Earlier output omitted; showing the last 64,000 characters]\n${value.slice(-64_000)}`; }

export function assertMutationIdentity(value: unknown, projectId: string, request: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Builder action returned an invalid response.");
  const payload = value as Record<string, unknown>;
  const bindings = { session: "sessionId", checkpoint: "checkpointId", verification: "verificationId", deployment: "deploymentId", release: "releaseId", repositoryBinding: "repositoryBindingId" } as const;
  for (const [field, target] of Object.entries(bindings)) {
    const record = payload[field];
    if (record === undefined || record === null) continue;
    if (typeof record !== "object" || Array.isArray(record)) throw new Error("Builder action returned an invalid record.");
    const row = record as Record<string, unknown>;
    if (typeof row.id !== "string" || request[target] && row.id !== request[target] || "projectId" in row && row.projectId !== projectId || "sessionId" in row && request.sessionId && row.sessionId !== request.sessionId) throw new Error("Builder action response does not match its exact submitted target.");
    for (const reference of ["checkpointId", "verificationId", "deploymentId", "releaseDigest", "repositoryId"] as const) {
      if (reference in row && reference in request && row[reference] !== request[reference]) throw new Error("Builder action response changed a submitted evidence reference.");
    }
  }
}
