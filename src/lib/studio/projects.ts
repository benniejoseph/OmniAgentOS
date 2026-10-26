import { createHash } from "node:crypto";
import { z } from "zod";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService } from "@/lib/app-services/projects";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { studioOwner, verifyStudioAuthority } from "./authority";
import {
  studioCanonicalJson,
  studioProjectProfileInputSchema,
  type StudioGraph,
  type StudioProject,
  type StudioProjectProfile,
} from "./contracts";
import { requireStudioProject, studioProjectCatalog } from "./project-catalog";
import {
  StudioError,
  type StoredRequest,
  type StudioOwner,
} from "./server-types";
import { withStudioTransaction, type StudioTransaction } from "./store";

const hash = (value: unknown) =>
  createHash("sha256").update(studioCanonicalJson(value)).digest("hex");
const createProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    profile: studioProjectProfileInputSchema,
  })
  .strict();
const updateProfileSchema = z
  .object({
    revision: z.number().int().min(0),
    profile: studioProjectProfileInputSchema,
  })
  .strict();
const requestId = (owner: StudioOwner, action: string, key: string) =>
  `studio_request_${hash([owner.tenantId, owner.actorId, action, key])}`;

export async function listStudioProjects(
  context: SecurityContext,
): Promise<StudioProject[]> {
  const owner = studioOwner(context);
  return withStudioTransaction(owner, async (tx) => {
    await verifyStudioAuthority(tx, owner);
    const projects = await studioProjectCatalog(tx, owner);
    const profiles = await tx.list<StudioProjectProfile>(
      "project_profile",
      undefined,
      200,
      { projectIds: projects.map((project) => project.id) },
    );
    return projects.map((project) => ({
      ...project,
      profile:
        profiles.find((profile) => profile.projectId === project.id) ?? null,
    }));
  });
}
export async function getStudioProjectProfile(
  context: SecurityContext,
  projectId: string,
) {
  const owner = studioOwner(context);
  return withStudioTransaction(owner, async (tx) => {
    const project = await requireStudioProject(tx, owner, projectId);
    await verifyStudioAuthority(tx, owner, project.workspaceId, project.id);
    const profile = await tx.get<StudioProjectProfile>(
      "project_profile",
      project.id,
    );
    return { project: { ...project, profile }, profile };
  });
}
export async function updateStudioProjectProfile(
  context: SecurityContext,
  projectId: string,
  body: unknown,
  key: string,
) {
  const input = updateProfileSchema.parse(body),
    owner = studioOwner(context);
  return withStudioTransaction(owner, async (tx) => {
    const project = await requireStudioProject(tx, owner, projectId);
    await verifyStudioAuthority(tx, owner, project.workspaceId, project.id);
    const rid = requestId(owner, "project.profile", key),
      requestHash = hash([project.id, input]);
    const previous = await tx.get<StoredRequest>("request", rid);
    if (previous && previous.requestHash !== requestHash)
      throw new StudioError(
        "This request key belongs to another profile change.",
        409,
        "studio_idempotency_conflict",
      );
    const profile = await tx.get<StudioProjectProfile>(
      "project_profile",
      project.id,
    );
    if (previous) return { project: { ...project, profile }, profile };
    if ((profile?.revision ?? 0) !== input.revision)
      throw new StudioError(
        "This brand profile changed elsewhere. Reload it before saving.",
        409,
        "studio_profile_revision_conflict",
      );
    const next: StudioProjectProfile = {
      ...input.profile,
      projectId: project.id,
      revision: input.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await tx.put("project_profile", project.id, next);
    await tx.put("request", rid, {
      requestHash,
      kind: "project_profile",
      targetId: project.id,
    });
    await tx.event(
      `studio_project:${project.id}`,
      "project.profile.updated",
      `Brand profile saved at revision ${next.revision}.`,
    );
    return { project: { ...project, profile: next }, profile: next };
  });
}
export async function createStudioProject(
  context: SecurityContext,
  body: unknown,
  key: string,
) {
  const input = createProjectSchema.parse(body),
    owner = studioOwner(context);
  const rid = requestId(owner, "project.create", key),
    digest = hash(input);
  // Claim the complete intent before creating the canonical Project. A lost response
  // retries the same deterministic target, including if profile initialization failed.
  await withStudioTransaction(owner, async (tx) => {
    await verifyStudioAuthority(tx, owner);
    const previous = await tx.get<StoredRequest>("request", rid);
    if (previous && previous.requestHash !== digest)
      throw new StudioError(
        "This request key belongs to another project.",
        409,
        "studio_idempotency_conflict",
      );
    if (!previous)
      await tx.put("request", rid, {
        requestHash: digest,
        kind: "project_profile",
        targetId: rid,
      });
  });
  const canonicalKey = `studio-project:${hash([owner.tenantId, owner.actorId, key])}`;
  const caller = createAppServiceCaller({
    context,
    idempotencyKey: canonicalKey,
    executionScope: executionScopeFromSecurityContext(context, {
      purpose: "studio.project.create",
      correlationId: canonicalKey,
    }),
  });
  const created = await createProjectService(caller, {
    title: input.title,
    objective: `Create and organize visual content for ${input.profile.brandName}.`,
    status: "active",
  });
  const { project } = await updateStudioProjectProfile(
    context,
    created.data.project.id,
    { revision: 0, profile: input.profile },
    `${canonicalKey}:profile`,
  );
  return project;
}
export async function graphWithStudioProjectContext(
  tx: StudioTransaction,
  owner: StudioOwner,
  graph: StudioGraph,
  projectId: string | null,
): Promise<StudioGraph> {
  const { projectContext: _submittedContext, ...draft } = graph;
  if (!projectId) return draft;
  const project = await requireStudioProject(tx, owner, projectId);
  const profile = await tx.get<StudioProjectProfile>(
    "project_profile",
    project.id,
  );
  if (!profile) return draft;
  const { revision, updatedAt: _updatedAt, ...context } = profile;
  return {
    ...draft,
    projectContext: { ...context, profileRevision: revision },
  };
}
