import "server-only";

import { z } from "zod";
import {
  commandContextReferencesSchema,
  type CommandContextKind,
  type CommandContextReference,
} from "@/lib/command/composer-context-contract";
import {
  resolveCommandContextReferences,
  type ResolvedCommandContextV1,
} from "@/lib/command/context-reference-runtime";
import {
  CommandModelSelectionError,
  commandModelSelectionRequestSchema,
  type CommandModelSelectionRequest,
} from "@/lib/models/command-selection";
import { modelAssignmentScopeForAgent } from "@/lib/orchestration/computer-use-routing";
import {
  canonicalRequestActorBindingFromSecurityContext,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  resolveRuntimeModelAssignment,
  type RuntimeModelResolution,
} from "@/lib/settings/runtime-models";
import {
  MODEL_ASSIGNMENT_SCOPES,
  type ModelAssignmentScope,
} from "@/lib/settings/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { WorkflowExecutionAuthority } from "@/lib/workflows/store";

export const WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION =
  "workflow-command-context-v1" as const;
export const WORKFLOW_COMMAND_CONTEXT_METADATA_KEY =
  "_workflowCommandContext" as const;
export const WORKFLOW_COMMAND_MODEL_POLICY_VERSION =
  "workflow-command-model-v1" as const;
export const WORKFLOW_COMMAND_MODEL_METADATA_KEY =
  "_workflowCommandModel" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const contractIdSchema = z.string().trim().min(1).max(320);
const actorBindingSchema = z.object({
  version: z.literal(1),
  kind: z.literal("auth_user"),
  authUserId: z.string().uuid(),
  canonicalActorId: contractIdSchema,
  legacyOwnerActorIds: z.array(contractIdSchema).length(1),
  readableOwnerActorIds: z.array(contractIdSchema).length(2),
}).strict();
const kindCountsSchema = z.object({
  agent: z.number().int().min(0).max(20).optional(),
  skill: z.number().int().min(0).max(20).optional(),
  plugin: z.number().int().min(0).max(20).optional(),
  project: z.number().int().min(0).max(20).optional(),
  integration: z.number().int().min(0).max(20).optional(),
  file: z.number().int().min(0).max(20).optional(),
}).strict();

const workflowCommandContextBoundaryBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION),
  selectionSha256: sha256Schema,
  pinsSha256: sha256Schema,
  contextBlockSha256: sha256Schema,
  receiptSha256: sha256Schema,
  referenceCount: z.number().int().min(1).max(20),
  kindCounts: kindCountsSchema,
}).strict();
const workflowCommandContextBoundarySchema =
  workflowCommandContextBoundaryBodySchema.extend({
    boundarySha256: sha256Schema,
  }).strict();

export type WorkflowCommandContextBoundaryV1 = Readonly<
  z.infer<typeof workflowCommandContextBoundarySchema>
>;

const workflowCommandContextBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION),
  references: commandContextReferencesSchema,
  boundary: workflowCommandContextBoundarySchema,
  actorBinding: actorBindingSchema.nullable(),
  workflowExecutionScopeSha256: sha256Schema,
}).strict();
const workflowCommandContextBindingSchema =
  workflowCommandContextBindingBodySchema.extend({
    bindingSha256: sha256Schema,
  }).strict();

export type WorkflowCommandContextBindingV1 = Readonly<{
  schemaVersion: 1;
  policyVersion: typeof WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION;
  references: readonly CommandContextReference[];
  boundary: WorkflowCommandContextBoundaryV1;
  actorBinding: CanonicalRequestActorBindingV1 | null;
  workflowExecutionScopeSha256: string;
  bindingSha256: string;
}>;

const workflowCommandModelBoundaryBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_COMMAND_MODEL_POLICY_VERSION),
  assignmentScope: z.enum(MODEL_ASSIGNMENT_SCOPES),
  primaryAgentIdSha256: sha256Schema,
  selectionSha256: sha256Schema,
}).strict();
const workflowCommandModelBoundarySchema =
  workflowCommandModelBoundaryBodySchema.extend({
    boundarySha256: sha256Schema,
  }).strict();

export type WorkflowCommandModelBoundaryV1 = Readonly<
  z.infer<typeof workflowCommandModelBoundarySchema>
>;

const workflowCommandModelBindingBodySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(WORKFLOW_COMMAND_MODEL_POLICY_VERSION),
  primaryAgentId: contractIdSchema,
  selection: commandModelSelectionRequestSchema,
  boundary: workflowCommandModelBoundarySchema,
  workflowExecutionScopeSha256: sha256Schema,
}).strict();
const workflowCommandModelBindingSchema =
  workflowCommandModelBindingBodySchema.extend({
    bindingSha256: sha256Schema,
  }).strict();

export type WorkflowCommandModelBindingV1 = Readonly<
  z.infer<typeof workflowCommandModelBindingSchema>
>;

export function createWorkflowCommandContextBoundary(
  resolved: ResolvedCommandContextV1,
): WorkflowCommandContextBoundaryV1 {
  const body = workflowCommandContextBoundaryBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION,
    selectionSha256: resolved.selectionSha256,
    pinsSha256: canonicalJsonSha256(resolved.pins),
    contextBlockSha256: resolved.contextBlockSha256,
    receiptSha256: resolved.receiptSha256,
    referenceCount: resolved.pins.length,
    kindCounts: normalizedKindCounts(resolved.kindCounts),
  });
  return Object.freeze(workflowCommandContextBoundarySchema.parse({
    ...body,
    boundarySha256: canonicalJsonSha256(body),
  }));
}

export function parseWorkflowCommandContextBoundary(
  value: unknown,
): WorkflowCommandContextBoundaryV1 | undefined {
  if (value === undefined || value === null) return undefined;
  const boundary = workflowCommandContextBoundarySchema.parse(value);
  const { boundarySha256, ...body } = boundary;
  if (canonicalJsonSha256(body) !== boundarySha256) {
    throw new Error("Workflow Command context boundary digest does not match.");
  }
  return Object.freeze(boundary);
}

export function workflowCommandContextBoundariesEqual(
  left: WorkflowCommandContextBoundaryV1 | undefined,
  right: WorkflowCommandContextBoundaryV1 | undefined,
) {
  if (!left || !right) return left === right;
  return parseWorkflowCommandContextBoundary(left)?.boundarySha256 ===
    parseWorkflowCommandContextBoundary(right)?.boundarySha256;
}

export function createWorkflowCommandContextBinding(input: {
  context: SecurityContext;
  references: readonly CommandContextReference[];
  resolved: ResolvedCommandContextV1;
  workflowExecutionScope: ExecutionScope;
}): WorkflowCommandContextBindingV1 {
  const references = commandContextReferencesSchema.parse(input.references);
  if (!references.length) {
    throw new Error("Workflow Command context requires at least one reference.");
  }
  const boundary = createWorkflowCommandContextBoundary(input.resolved);
  if (canonicalJsonSha256(references) !== boundary.selectionSha256) {
    throw new Error("Workflow Command context references do not match their resolved selection.");
  }
  assertExecutionContext(input.workflowExecutionScope, input.context);
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    input.context,
  ) || null;
  if (actorBinding) assertActorBinding(actorBinding, input.context.actorId);
  const body = workflowCommandContextBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_COMMAND_CONTEXT_POLICY_VERSION,
    references,
    boundary,
    actorBinding,
    workflowExecutionScopeSha256: workflowExecutionScopeSha256(
      input.workflowExecutionScope,
    ),
  });
  return Object.freeze({
    ...body,
    references: Object.freeze([...references]),
    bindingSha256: canonicalJsonSha256(body),
  }) as WorkflowCommandContextBindingV1;
}

export function parseWorkflowCommandContextBinding(
  value: unknown,
): WorkflowCommandContextBindingV1 {
  const parsed = workflowCommandContextBindingSchema.parse(value);
  if (!parsed.references.length) {
    throw new Error("Workflow Command context binding has no references.");
  }
  const { bindingSha256, ...body } = parsed;
  if (canonicalJsonSha256(body) !== bindingSha256) {
    throw new Error("Workflow Command context binding digest does not match.");
  }
  const boundary = parseWorkflowCommandContextBoundary(parsed.boundary)!;
  if (canonicalJsonSha256(parsed.references) !== boundary.selectionSha256) {
    throw new Error("Workflow Command context selection digest does not match.");
  }
  return Object.freeze({
    ...parsed,
    references: Object.freeze([...parsed.references]),
    boundary,
  }) as WorkflowCommandContextBindingV1;
}

export async function resolveWorkflowCommandContext(input: {
  binding: unknown;
  executionAuthority: WorkflowExecutionAuthority;
  goal: string;
}): Promise<ResolvedCommandContextV1> {
  const binding = parseWorkflowCommandContextBinding(input.binding);
  assertWorkflowBindingScope(
    binding.workflowExecutionScopeSha256,
    input.executionAuthority.executionScope,
  );
  const context = securityContextForWorkflow(
    input.executionAuthority,
    binding.actorBinding,
  );
  const agentId = referenceId(binding.references, "agent");
  const projectId = referenceId(binding.references, "project");
  const resolved = await resolveCommandContextReferences({
    context,
    references: binding.references,
    query: input.goal,
    agentId,
    projectId,
  });
  if (!resolved) {
    throw new Error("Workflow Command context could not be resolved.");
  }
  const currentBoundary = createWorkflowCommandContextBoundary(resolved);
  if (!workflowCommandContextBoundariesEqual(binding.boundary, currentBoundary)) {
    throw new Error(
      "Workflow Command context changed after review. Create a fresh plan.",
    );
  }
  return resolved;
}

export async function resolveReviewedWorkflowCommandModel(input: {
  tenantId: string;
  actorId: string;
  primaryAgentId: string;
  selection: CommandModelSelectionRequest;
}): Promise<Readonly<{
  boundary: WorkflowCommandModelBoundaryV1;
  runtime: RuntimeModelResolution;
}>> {
  const selection = commandModelSelectionRequestSchema.parse(input.selection);
  const assignmentScope = modelAssignmentScopeForAgent(input.primaryAgentId);
  const runtime = await resolveRuntimeModelAssignment({
    tenantId: input.tenantId,
    actorId: input.actorId,
    scope: assignmentScope,
    tier: "reasoning",
    requiredFeature: "json_schema",
    commandSelection: selection,
  });
  if (!runtime.commandSelectionSha256 || !runtime.configured) {
    throw new CommandModelSelectionError(
      "The selected Command model cannot serve structured workflow planning and synthesis. Choose a compatible model.",
    );
  }
  const body = workflowCommandModelBoundaryBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_COMMAND_MODEL_POLICY_VERSION,
    assignmentScope,
    primaryAgentIdSha256: canonicalJsonSha256({
      contract: "workflow-command-primary-agent-v1",
      primaryAgentId: input.primaryAgentId,
    }),
    selectionSha256: runtime.commandSelectionSha256,
  });
  return Object.freeze({
    boundary: Object.freeze(workflowCommandModelBoundarySchema.parse({
      ...body,
      boundarySha256: canonicalJsonSha256(body),
    })),
    runtime,
  });
}

export function parseWorkflowCommandModelBoundary(
  value: unknown,
): WorkflowCommandModelBoundaryV1 | undefined {
  if (value === undefined || value === null) return undefined;
  const boundary = workflowCommandModelBoundarySchema.parse(value);
  const { boundarySha256, ...body } = boundary;
  if (canonicalJsonSha256(body) !== boundarySha256) {
    throw new Error("Workflow Command model boundary digest does not match.");
  }
  return Object.freeze(boundary);
}

export function workflowCommandModelBoundariesEqual(
  left: WorkflowCommandModelBoundaryV1 | undefined,
  right: WorkflowCommandModelBoundaryV1 | undefined,
) {
  if (!left || !right) return left === right;
  return parseWorkflowCommandModelBoundary(left)?.boundarySha256 ===
    parseWorkflowCommandModelBoundary(right)?.boundarySha256;
}

export function createWorkflowCommandModelBinding(input: {
  primaryAgentId: string;
  selection: CommandModelSelectionRequest;
  boundary: WorkflowCommandModelBoundaryV1;
  workflowExecutionScope: ExecutionScope;
}): WorkflowCommandModelBindingV1 {
  if (
    input.workflowExecutionScope.purpose !== "workflow.run" ||
    !input.workflowExecutionScope.initiatingActorId
  ) {
    throw new Error("Workflow Command model requires workflow root authority.");
  }
  const boundary = parseWorkflowCommandModelBoundary(input.boundary)!;
  if (
    boundary.primaryAgentIdSha256 !== canonicalJsonSha256({
      contract: "workflow-command-primary-agent-v1",
      primaryAgentId: input.primaryAgentId,
    })
  ) {
    throw new Error("Workflow Command model Agent pin does not match its boundary.");
  }
  const body = workflowCommandModelBindingBodySchema.parse({
    schemaVersion: 1,
    policyVersion: WORKFLOW_COMMAND_MODEL_POLICY_VERSION,
    primaryAgentId: input.primaryAgentId,
    selection: input.selection,
    boundary,
    workflowExecutionScopeSha256: workflowExecutionScopeSha256(
      input.workflowExecutionScope,
    ),
  });
  return Object.freeze(workflowCommandModelBindingSchema.parse({
    ...body,
    bindingSha256: canonicalJsonSha256(body),
  }));
}

export function parseWorkflowCommandModelBinding(
  value: unknown,
): WorkflowCommandModelBindingV1 {
  const binding = workflowCommandModelBindingSchema.parse(value);
  const { bindingSha256, ...body } = binding;
  if (canonicalJsonSha256(body) !== bindingSha256) {
    throw new Error("Workflow Command model binding digest does not match.");
  }
  parseWorkflowCommandModelBoundary(binding.boundary);
  if (
    binding.boundary.primaryAgentIdSha256 !== canonicalJsonSha256({
      contract: "workflow-command-primary-agent-v1",
      primaryAgentId: binding.primaryAgentId,
    })
  ) {
    throw new Error("Workflow Command model Agent pin does not match its binding.");
  }
  return Object.freeze(binding);
}

export async function resolveWorkflowCommandModel(input: {
  binding: unknown;
  executionAuthority: WorkflowExecutionAuthority;
}): Promise<Readonly<{
  binding: WorkflowCommandModelBindingV1;
  boundary: WorkflowCommandModelBoundaryV1;
  runtime: RuntimeModelResolution;
}>> {
  const binding = parseWorkflowCommandModelBinding(input.binding);
  assertWorkflowBindingScope(
    binding.workflowExecutionScopeSha256,
    input.executionAuthority.executionScope,
  );
  const actorId = input.executionAuthority.executionScope.initiatingActorId;
  if (!actorId) {
    throw new Error("Workflow Command model requires an initiating actor.");
  }
  const current = await resolveReviewedWorkflowCommandModel({
    tenantId: input.executionAuthority.executionScope.tenantId,
    actorId,
    primaryAgentId: binding.primaryAgentId,
    selection: binding.selection,
  });
  if (!workflowCommandModelBoundariesEqual(binding.boundary, current.boundary)) {
    throw new Error(
      "Workflow Command model changed after review. Choose the model again.",
    );
  }
  return Object.freeze({ binding, ...current });
}

export function primaryAgentIdForWorkflowCommand(
  references: readonly CommandContextReference[],
  fallback?: string,
) {
  return referenceId(references, "agent") || fallback || "atlas";
}

function normalizedKindCounts(
  value: Readonly<Partial<Record<CommandContextKind, number>>>,
) {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [CommandContextKind, number] =>
        typeof entry[1] === "number" && entry[1] > 0
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function referenceId(
  references: readonly CommandContextReference[],
  kind: CommandContextKind,
) {
  return references.find((reference) => reference.kind === kind)?.id;
}

function assertWorkflowBindingScope(
  expectedSha256: string,
  scope: ExecutionScope,
) {
  if (workflowExecutionScopeSha256(scope) !== expectedSha256) {
    throw new Error("Workflow Command binding no longer matches root authority.");
  }
}

function assertExecutionContext(
  scope: ExecutionScope,
  context: SecurityContext,
) {
  if (
    scope.tenantId !== context.tenantId ||
    !scope.initiatingActorId ||
    scope.initiatingActorId !== context.actorId ||
    scope.purpose !== "workflow.run"
  ) {
    throw new Error("Workflow Command context actor does not match root authority.");
  }
}

function assertActorBinding(
  binding: CanonicalRequestActorBindingV1,
  actorId: string,
) {
  const parsed = actorBindingSchema.parse(binding);
  if (
    parsed.canonicalActorId !== `actor:${parsed.authUserId}` ||
    parsed.legacyOwnerActorIds[0] !== actorId ||
    parsed.readableOwnerActorIds[0] !== parsed.canonicalActorId ||
    parsed.readableOwnerActorIds[1] !== actorId
  ) {
    throw new Error("Workflow Command canonical actor binding is invalid.");
  }
}

function securityContextForWorkflow(
  authority: WorkflowExecutionAuthority,
  actorBinding: CanonicalRequestActorBindingV1 | null,
): SecurityContext {
  const actorId = authority.executionScope.initiatingActorId;
  if (!actorId) {
    throw new Error("Workflow Command context requires an initiating actor.");
  }
  if (!actorBinding) {
    return Object.freeze({
      tenantId: authority.executionScope.tenantId,
      actorId,
      role: authority.requesterRole,
      source: "service" as const,
    });
  }
  assertActorBinding(actorBinding, actorId);
  return Object.freeze({
    tenantId: authority.executionScope.tenantId,
    actorId,
    role: authority.requesterRole,
    source: "session" as const,
    auth: Object.freeze({
      userId: actorBinding.authUserId,
      email: actorId,
      sessionId: `workflow:${canonicalJsonSha256({
        tenantId: authority.executionScope.tenantId,
        actorId,
        correlationId: authority.executionScope.correlationId,
      }).slice(0, 32)}`,
      tenantName: authority.executionScope.tenantId,
    }),
  });
}

function workflowExecutionScopeSha256(scope: ExecutionScope) {
  return canonicalJsonSha256({
    contract: "workflow-execution-scope-v1",
    executionScope: scope,
  });
}

export function workflowCommandModelAssignmentScope(
  boundary: WorkflowCommandModelBoundaryV1,
): ModelAssignmentScope {
  return parseWorkflowCommandModelBoundary(boundary)!.assignmentScope;
}
