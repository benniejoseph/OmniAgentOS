import { z } from "zod";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  databaseMemoryAccessScopeFromExecutionScope,
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import type { ContextScopeId } from "@/lib/rag/context-scope";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { personalWorkspaceId } from "@/lib/workspaces/contracts";

export const SHARED_CONTEXT_POLICY_VERSION = "workspace-context-policy-v1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const canonicalActorIdSchema = idSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const workspaceIdSchema = idSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const sharedContextAuthorityBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(SHARED_CONTEXT_POLICY_VERSION),
  tenantId: idSchema,
  scope: z.enum(["project", "workspace"]),
  initiatingActorId: canonicalActorIdSchema,
  workspaceId: workspaceIdSchema,
  projectId: idSchema.nullable(),
  requestedProjectId: idSchema.nullable(),
  accessLevel: z.enum(["reader", "contributor", "manager"]),
  canWrite: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.scope === "project") !== (value.projectId !== null)) {
    context.addIssue({ code: "custom", message: "Shared context coordinates are inconsistent." });
  }
  if (value.canWrite !== ["contributor", "manager"].includes(value.accessLevel)) {
    context.addIssue({ code: "custom", message: "Shared context write authority is inconsistent." });
  }
});

export const sharedContextAuthorityV1Schema = sharedContextAuthorityBodySchema
  .extend({ authoritySha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { authoritySha256: _authoritySha256, ...body } = value;
    void _authoritySha256;
    if (value.authoritySha256 !== sourceContractSha256(body)) {
      context.addIssue({ code: "custom", message: "Shared context authority digest does not match." });
    }
  });

export type SharedContextAuthorityV1 = Readonly<
  z.infer<typeof sharedContextAuthorityV1Schema>
>;

export type RequestSharedMemoryAccessV1 = Readonly<{
  actorBinding: CanonicalRequestActorBindingV1;
  authority: SharedContextAuthorityV1;
  executionScope: ExecutionScope;
  databaseAccessScope: DatabaseMemoryAccessScope;
}>;

type SharedMemoryAccessPurposeId =
  | typeof MEMORY_PURPOSE_IDS.read
  | typeof MEMORY_PURPOSE_IDS.retrieve
  | typeof MEMORY_PURPOSE_IDS.write;

export class SharedContextAuthorityError extends Error {
  readonly code: "postgres_required" | "canonical_actor_required" | "scope_not_found";

  constructor(
    code: SharedContextAuthorityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SharedContextAuthorityError";
    this.code = code;
  }
}

export async function requestSharedMemoryAccessFromSecurityContext(
  context: SecurityContext,
  input: {
    scope: "project" | "workspace";
    projectId?: string;
    workspaceId?: string;
    correlationId: string;
    purposeId?: SharedMemoryAccessPurposeId;
    auditPurpose?: string;
  },
): Promise<RequestSharedMemoryAccessV1> {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!actorBinding) {
    throw new SharedContextAuthorityError(
      "canonical_actor_required",
      "Shared context requires an authenticated canonical user.",
    );
  }
  const authority = await resolveSharedContextAuthority({
    tenantId: context.tenantId,
    canonicalActorId: actorBinding.canonicalActorId,
    scope: input.scope,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
  });
  const purposeId = input.purposeId || MEMORY_PURPOSE_IDS.retrieve;
  const auditPurpose = input.auditPurpose ||
    "Retrieve explicitly selected shared workspace context.";
  const executionScope = createExecutionScope({
    tenantId: context.tenantId,
    initiatingActorId: actorBinding.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorBinding.canonicalActorId,
    workspaceId: authority.workspaceId,
    projectId: authority.projectId,
    correlationId: input.correlationId,
    purpose: sharedMemoryExecutionPurpose(purposeId),
  });
  const databaseAccessScope = databaseMemoryAccessScopeFromExecutionScope(
    executionScope,
    {
      purposeId,
      auditPurpose,
    },
  );
  return Object.freeze({
    actorBinding,
    authority,
    executionScope,
    databaseAccessScope,
  });
}

function sharedMemoryExecutionPurpose(purposeId: SharedMemoryAccessPurposeId) {
  if (purposeId === MEMORY_PURPOSE_IDS.read) return "app.memory.shared.read";
  if (purposeId === MEMORY_PURPOSE_IDS.write) return "app.memory.shared.write";
  return "agent.context.shared.retrieve";
}

export function resolveSharedAgentPromptMemoryAccess(
  value: RequestSharedMemoryAccessV1 | undefined,
  input: {
    agentExecutionScope: ExecutionScope;
    contextScope?: ContextScopeId;
    memoryMode: "session" | "project" | "all";
  },
): DatabaseMemoryAccessScope | undefined {
  if (!value) return undefined;
  const fail = () => {
    throw new Error("Shared-memory prompt access is invalid.");
  };
  if (
    !input.contextScope ||
    !["mission", "project", "workspace"].includes(input.contextScope) ||
    input.memoryMode !== "all"
  ) {
    return fail();
  }

  const promptScope = parsePersistedExecutionScope(value.executionScope);
  if (!promptScope) return fail();
  const databaseScope = parseDatabaseMemoryAccessScope(
    value.databaseAccessScope,
  );
  const expectedDatabaseScope = databaseMemoryAccessScopeFromExecutionScope(
    promptScope,
    {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: "Retrieve explicitly selected shared workspace context.",
    },
  );
  const authority = sharedContextAuthorityV1Schema.parse(value.authority);
  const expectedAuthorityScope = input.contextScope === "mission"
    ? "project"
    : input.contextScope;
  const expectedMissionId = input.contextScope === "mission"
    ? authority.requestedProjectId
    : null;
  const actorBinding = value.actorBinding;
  const canonicalActorId = `actor:${actorBinding.authUserId}`;
  const agentScope = input.agentExecutionScope;
  if (
    actorBinding.version !== 1 ||
    actorBinding.kind !== "auth_user" ||
    actorBinding.canonicalActorId !== canonicalActorId ||
    authority.scope !== expectedAuthorityScope ||
    (input.contextScope === "mission" && !expectedMissionId) ||
    authority.tenantId !== promptScope.tenantId ||
    authority.initiatingActorId !== canonicalActorId ||
    promptScope.initiatingActorId !== canonicalActorId ||
    promptScope.executingPrincipalType !== "user" ||
    promptScope.executingPrincipalId !== canonicalActorId ||
    promptScope.workspaceId !== authority.workspaceId ||
    promptScope.projectId !== authority.projectId ||
    promptScope.missionId !== null ||
    promptScope.contextGrantIds.length !== 0 ||
    promptScope.capabilityGrantIds.length !== 0 ||
    promptScope.purpose !== "agent.context.shared.retrieve" ||
    agentScope.executingPrincipalType !== "agent" ||
    agentScope.tenantId !== authority.tenantId ||
    !actorBinding.readableOwnerActorIds.includes(agentScope.initiatingActorId || "") ||
    agentScope.workspaceId !== authority.workspaceId ||
    agentScope.projectId !== authority.projectId ||
    agentScope.missionId !== expectedMissionId ||
    agentScope.correlationId !== promptScope.correlationId ||
    serializeDatabaseMemoryAccessScope(databaseScope) !==
      serializeDatabaseMemoryAccessScope(expectedDatabaseScope)
  ) {
    return fail();
  }
  return databaseScope;
}

export async function resolveSharedContextAuthority(input: {
  tenantId: string;
  canonicalActorId: string;
  scope: "project" | "workspace";
  projectId?: string;
  workspaceId?: string;
}): Promise<SharedContextAuthorityV1> {
  if (!hasDatabaseUrl()) {
    throw new SharedContextAuthorityError(
      "postgres_required",
      "Shared context requires the canonical database authority.",
    );
  }
  await ensureDatabaseSchema();
  const sql = getSql();
  if (input.scope === "project") {
    const requestedProjectId = idSchema.parse(input.projectId);
    const rows = await sql`
      SELECT project.workspace_id, project.project_id,
             membership.access_level
      FROM omni_work_projects project
      JOIN omni_work_project_memberships membership
        ON membership.tenant_id = project.tenant_id
       AND membership.workspace_id = project.workspace_id
       AND membership.project_id = project.project_id
       AND membership.subject_actor_id = ${input.canonicalActorId}
       AND membership.state = 'active'
      JOIN omni_tenant_workspaces workspace
        ON workspace.tenant_id = project.tenant_id
       AND workspace.workspace_id = project.workspace_id
       AND workspace.state = 'active'
      WHERE project.tenant_id = ${input.tenantId}
        AND project.lifecycle_status <> 'archived'
        AND (
          project.project_id = ${requestedProjectId}
          OR EXISTS (
            SELECT 1 FROM omni_work_compatibility_mappings mapping
            WHERE mapping.tenant_id = project.tenant_id
              AND mapping.workspace_id = project.workspace_id
              AND mapping.project_id = project.project_id
              AND mapping.source_id = ${requestedProjectId}
              AND mapping.source_kind IN ('legacy_project', 'legacy_mission')
              AND mapping.state = 'active'
          )
        )
      ORDER BY project.project_id
      LIMIT 2
    `;
    if (rows.length !== 1) return scopeNotFound();
    return buildSharedContextAuthority({
      ...input,
      workspaceId: String(rows[0].workspace_id),
      projectId: String(rows[0].project_id),
      requestedProjectId,
      accessLevel: rows[0].access_level,
    });
  }

  const requestedProjectId = input.projectId
    ? idSchema.parse(input.projectId)
    : null;
  let workspaceId = input.workspaceId
    ? workspaceIdSchema.parse(input.workspaceId)
    : personalWorkspaceId(input.canonicalActorId);
  if (requestedProjectId) {
    const projectAuthority = await resolveSharedContextAuthority({
      ...input,
      scope: "project",
      projectId: requestedProjectId,
    });
    workspaceId = projectAuthority.workspaceId;
  }
  const rows = await sql`
    SELECT workspace.workspace_id, membership.access_level
    FROM omni_tenant_workspaces workspace
    JOIN omni_tenant_workspace_memberships membership
      ON membership.tenant_id = workspace.tenant_id
     AND membership.workspace_id = workspace.workspace_id
     AND membership.subject_kind = 'user'
     AND membership.subject_actor_id = ${input.canonicalActorId}
     AND membership.state = 'active'
    WHERE workspace.tenant_id = ${input.tenantId}
      AND workspace.workspace_id = ${workspaceId}
      AND workspace.state = 'active'
    LIMIT 2
  `;
  if (rows.length !== 1) return scopeNotFound();
  return buildSharedContextAuthority({
    ...input,
    workspaceId: String(rows[0].workspace_id),
    projectId: null,
    requestedProjectId,
    accessLevel: rows[0].access_level,
  });
}

function buildSharedContextAuthority(input: {
  tenantId: string;
  canonicalActorId: string;
  scope: "project" | "workspace";
  workspaceId: string;
  projectId: string | null;
  requestedProjectId: string | null;
  accessLevel: unknown;
}) {
  const body = sharedContextAuthorityBodySchema.parse({
    schemaVersion: 1,
    policyVersion: SHARED_CONTEXT_POLICY_VERSION,
    tenantId: input.tenantId,
    scope: input.scope,
    initiatingActorId: input.canonicalActorId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    requestedProjectId: input.requestedProjectId,
    accessLevel: input.accessLevel,
    canWrite: ["contributor", "manager"].includes(String(input.accessLevel)),
  });
  return Object.freeze(sharedContextAuthorityV1Schema.parse({
    ...body,
    authoritySha256: sourceContractSha256(body),
  }));
}

function scopeNotFound(): never {
  throw new SharedContextAuthorityError(
    "scope_not_found",
    "The selected shared context is unavailable to this actor.",
  );
}
