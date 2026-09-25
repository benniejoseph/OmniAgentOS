import { z } from "zod";

import {
  activateAgentAdaptation,
  evaluateAgentAdaptation,
  listAgentAdaptations,
  observeAgentAdaptationEvidence,
  rollbackAgentAdaptation,
} from "@/lib/agents/adaptation-store";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import {
  evaluateAgentRelease,
  getAgentRelease,
  promoteAgentRelease,
  retireAgentRelease,
  rollbackAgentRelease,
} from "@/lib/agents/release-store";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { agentMemoryGrantDraftV1Schema } from "@/lib/memory/agent-grant-editor";
import {
  createAgentMemoryGrant,
  listAgentMemoryGrants,
  revokeAgentMemoryGrant,
} from "@/lib/memory/agent-grant-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const agentIdSchema = z.object({ agentId: z.string().trim().min(1).max(200) }).strict();
const releaseEvaluationSchema = agentIdSchema.extend({
  definitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const releaseTransitionSchema = agentIdSchema.extend({
  action: z.enum(["promote", "rollback"]),
  evaluationId: z.string().regex(/^agent-release-evaluation:[a-f0-9]{64}$/),
}).strict();
const exactTargetSchema = agentIdSchema.extend({
  expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const grantCreateSchema = agentIdSchema.extend({
  grant: agentMemoryGrantDraftV1Schema,
}).strict();
const grantIdSchema = agentIdSchema.extend({
  grantId: z.string().regex(/^(context|capability):[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
}).strict();
const grantRevokeSchema = grantIdSchema.extend({
  expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const adaptationIdSchema = z.string().regex(/^agent-adaptation:[a-f0-9]{64}$/);
const adaptationManageSchema = agentIdSchema.extend({
  action: z.enum(["evaluate", "activate", "rollback"]),
  adaptationId: adaptationIdSchema,
}).strict();

export async function showAgentReleaseService(caller: AppServiceCaller, input: z.input<typeof agentIdSchema>) {
  const value = agentIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.release.show"));
  const release = await getAgentRelease(value.agentId, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { release }, { resourceCount: 1 });
}

export async function evaluateAgentReleaseService(caller: AppServiceCaller, input: z.input<typeof releaseEvaluationSchema>) {
  const value = releaseEvaluationSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.release.evaluate"));
  const release = await evaluateAgentRelease(value.agentId, value.definitionVersion, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { release }, { resourceCount: 1 });
}

export async function transitionAgentReleaseService(caller: AppServiceCaller, input: z.input<typeof releaseTransitionSchema>) {
  const value = releaseTransitionSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.release.transition"));
  const owner = canonicalOwner(caller);
  const release = value.action === "promote"
    ? await promoteAgentRelease(value.agentId, value.evaluationId, owner)
    : await rollbackAgentRelease(value.agentId, value.evaluationId, owner);
  return completeAppServiceCall(authorized, { release }, { resourceCount: 1 });
}

export async function previewAgentRetirementService(caller: AppServiceCaller, input: z.input<typeof agentIdSchema>) {
  const value = agentIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.release.retire.preview"));
  const release = await getAgentRelease(value.agentId, canonicalOwner(caller));
  const target = {
    agentId: value.agentId,
    state: release.state,
    activeDefinitionVersion: release.activeDefinitionVersion,
    versionIds: release.versions.map((version) => version.definitionVersionId).sort(),
  };
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target) }, { resourceCount: 1 });
}

export async function retireAgentReleaseService(caller: AppServiceCaller, input: z.input<typeof exactTargetSchema>) {
  const value = exactTargetSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.release.retire"));
  const preview = await previewAgentRetirementService(caller, { agentId: value.agentId });
  if (preview.data.targetSha256 !== value.expectedTargetSha256) {
    throw new Error("Agent retirement target changed after preview; review the exact target again.");
  }
  const release = await retireAgentRelease(value.agentId, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { release, target: preview.data.target, targetSha256: preview.data.targetSha256 }, { resourceCount: 1 });
}

export async function listAgentGrantsService(caller: AppServiceCaller, input: z.input<typeof agentIdSchema>) {
  const value = agentIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.grants.list"));
  const grants = await listAgentMemoryGrants(value.agentId, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { grants }, { resourceCount: grants.length });
}

export async function createAgentGrantService(caller: AppServiceCaller, input: z.input<typeof grantCreateSchema>) {
  const value = grantCreateSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.grants.create"));
  const grant = await createAgentMemoryGrant(value.agentId, value.grant, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { grant }, { resourceCount: 1 });
}

export async function previewAgentGrantRevokeService(caller: AppServiceCaller, input: z.input<typeof grantIdSchema>) {
  const value = grantIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.grants.revoke.preview"));
  const grants = await listAgentMemoryGrants(value.agentId, canonicalOwner(caller));
  const grant = grants.find((entry) => entry.record.grantId === value.grantId) || null;
  const target = grant ? { agentId: value.agentId, grant: grant.record } : null;
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target) }, { resourceCount: target ? 1 : 0 });
}

export async function revokeAgentGrantService(caller: AppServiceCaller, input: z.input<typeof grantRevokeSchema>) {
  const value = grantRevokeSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.grants.revoke"));
  const preview = await previewAgentGrantRevokeService(caller, { agentId: value.agentId, grantId: value.grantId });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) {
    throw new Error("Agent grant revocation target changed after preview; review the exact target again.");
  }
  await revokeAgentMemoryGrant(value.agentId, value.grantId, canonicalOwner(caller));
  return completeAppServiceCall(authorized, { revoked: true, target: preview.data.target, targetSha256: preview.data.targetSha256 }, { resourceCount: 1 });
}

export async function listAgentAdaptationsService(caller: AppServiceCaller, input: z.input<typeof agentIdSchema>) {
  const value = agentIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.adaptations.list"));
  const owner = canonicalOwner(caller);
  const identity = await currentIdentity(value.agentId, caller);
  const adaptations = await listAgentAdaptations(value.agentId, owner);
  return completeAppServiceCall(authorized, { adaptations, definitionVersion: identity.definition.definitionVersion }, { resourceCount: adaptations.length });
}

export async function refreshAgentAdaptationsService(caller: AppServiceCaller, input: z.input<typeof agentIdSchema>) {
  const value = agentIdSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.adaptations.refresh"));
  const owner = canonicalOwner(caller);
  const identity = await currentIdentity(value.agentId, caller);
  const adaptations = await observeAgentAdaptationEvidence(value.agentId, identity.definition.definitionVersion, owner);
  return completeAppServiceCall(authorized, { adaptations, definitionVersion: identity.definition.definitionVersion }, { resourceCount: adaptations.length });
}

export async function manageAgentAdaptationService(caller: AppServiceCaller, input: z.input<typeof adaptationManageSchema>) {
  const value = adaptationManageSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.agents.adaptations.manage"));
  const owner = canonicalOwner(caller);
  const identity = await currentIdentity(value.agentId, caller);
  const version = identity.definition.definitionVersion;
  const adaptations = value.action === "evaluate"
    ? await evaluateAgentAdaptation(value.agentId, value.adaptationId, version, owner)
    : value.action === "activate"
      ? await activateAgentAdaptation(value.agentId, value.adaptationId, version, owner)
      : await rollbackAgentAdaptation(value.agentId, value.adaptationId, version, owner);
  return completeAppServiceCall(authorized, { adaptations, definitionVersion: version }, { resourceCount: adaptations.length });
}

function canonicalOwner(caller: AppServiceCaller) {
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (!binding) throw new Error("Canonical Agent ownership could not be verified.");
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    canonicalActorId: binding.canonicalActorId,
  };
}

function currentIdentity(agentId: string, caller: AppServiceCaller) {
  return resolveAgentIdentityForExecution({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    agentId,
  });
}
