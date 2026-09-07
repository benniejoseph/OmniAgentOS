import { randomUUID } from "node:crypto";
import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const WORKSPACE_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_TEMPLATE_EVENT_TYPES = Object.freeze({
  published: "workspace.template.published",
  instantiated: "workspace.template.instantiated",
} as const);

const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const templateIdSchema = opaqueIdSchema.regex(
  /^workspace-template:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const agentIdSchema = z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]);

export const workspaceTemplateToolBindingSchema = z.object({
  toolId: opaqueIdSchema,
  input: z.record(z.string(), z.unknown()),
}).strict().superRefine((binding, context) => {
  if (!isJsonValue(binding.input)) {
    context.addIssue({ code: "custom", message: "Playbook tool input must be JSON data." });
    return;
  }
  if (containsSensitiveField(binding.input)) {
    context.addIssue({
      code: "custom",
      message: "Playbook tool input cannot contain credentials or secret-bearing fields.",
    });
  }
  if (Buffer.byteLength(JSON.stringify(binding.input), "utf8") > 32_000) {
    context.addIssue({ code: "custom", message: "Playbook tool input is too large." });
  }
});

export const workspaceTemplateTaskSchema = z.object({
  key: opaqueIdSchema.max(80),
  title: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(1_000).default(""),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  agentId: agentIdSchema.default("atlas"),
  dependsOnKeys: z.array(opaqueIdSchema.max(80)).max(20).default([]),
}).strict();

export const workspaceTemplateProjectSchema = z.object({
  title: z.string().trim().min(1).max(180),
  objective: z.string().trim().min(1).max(2_000),
  status: z.enum(["draft", "active"]).default("draft"),
  tasks: z.array(workspaceTemplateTaskSchema).max(20).default([]),
}).strict().superRefine((project, context) => {
  const keys = project.tasks.map((task) => task.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Template task keys must be unique." });
    return;
  }
  const titles = project.tasks.map((task) => task.title.toLowerCase());
  if (new Set(titles).size !== titles.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Template task titles must be unique." });
  }
  const known = new Set(keys);
  project.tasks.forEach((task, taskIndex) => {
    if (new Set(task.dependsOnKeys).size !== task.dependsOnKeys.length) {
      context.addIssue({ code: "custom", path: ["tasks", taskIndex, "dependsOnKeys"], message: "Task dependencies must be unique." });
    }
    for (const dependency of task.dependsOnKeys) {
      if (!known.has(dependency) || dependency === task.key) {
        context.addIssue({ code: "custom", path: ["tasks", taskIndex, "dependsOnKeys"], message: "Task dependency is missing or self-referential." });
      }
    }
  });
  if (hasDependencyCycle(project.tasks)) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Template task dependencies must be acyclic." });
  }
});

export const workspaceTemplatePlaybookSchema = z.object({
  aliases: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).default("orchestrate"),
  toolBindings: z.array(workspaceTemplateToolBindingSchema).min(1).max(12),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
}).strict().superRefine((playbook, context) => {
  const aliases = playbook.aliases.map(normalizeProcedureAlias);
  if (aliases.some((alias) => !alias) || new Set(aliases).size !== aliases.length) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "Playbook aliases must remain unique after normalization." });
  }
  const toolIds = playbook.toolBindings.map((binding) => binding.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({ code: "custom", path: ["toolBindings"], message: "A playbook can bind each tool only once." });
  }
  if (Buffer.byteLength(JSON.stringify(playbook.toolBindings), "utf8") > 64_000) {
    context.addIssue({ code: "custom", path: ["toolBindings"], message: "Playbook bindings are too large." });
  }
});

export const workspaceTemplateDefinitionInputSchema = z.object({
  templateId: templateIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
  project: workspaceTemplateProjectSchema,
  playbook: workspaceTemplatePlaybookSchema.nullable().default(null),
}).strict();

const workspaceTemplateVersionBodySchema = z.object({
  schemaVersion: z.literal(WORKSPACE_TEMPLATE_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  templateId: templateIdSchema,
  templateVersionId: opaqueIdSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ownerActorId: canonicalActorIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000),
  project: workspaceTemplateProjectSchema,
  playbook: workspaceTemplatePlaybookSchema.nullable(),
  previousTemplateVersionId: opaqueIdSchema.nullable(),
  publishedByActorId: canonicalActorIdSchema,
  publishedAt: canonicalTimestampSchema,
}).strict().superRefine((template, context) => {
  if (template.templateVersionId !== `${template.templateId}:v${template.version}`) {
    context.addIssue({ code: "custom", path: ["templateVersionId"], message: "Template version identity is inconsistent." });
  }
  const expectedPrevious = template.version === 1
    ? null
    : `${template.templateId}:v${template.version - 1}`;
  if (template.previousTemplateVersionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousTemplateVersionId"], message: "Template version lineage is inconsistent." });
  }
});

export const workspaceTemplateVersionSchema = workspaceTemplateVersionBodySchema.extend({
  templateSha256: sha256Schema,
}).strict().superRefine((template, context) => {
  const { templateSha256: _digest, ...body } = template;
  if (canonicalJsonSha256(body) !== template.templateSha256) {
    context.addIssue({ code: "custom", path: ["templateSha256"], message: "Template digest does not match its immutable version." });
  }
});

export const workspaceTemplateInstantiationSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_TEMPLATE_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  instantiationId: opaqueIdSchema,
  templateId: templateIdSchema,
  templateVersionId: opaqueIdSchema,
  templateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  templateSha256: sha256Schema,
  projectId: opaqueIdSchema,
  projectSnapshotSha256: sha256Schema,
  instantiatedByActorId: canonicalActorIdSchema,
  instantiatedAt: canonicalTimestampSchema,
}).strict();

export type WorkspaceTemplateToolBinding = Readonly<z.infer<typeof workspaceTemplateToolBindingSchema>>;
export type WorkspaceTemplateTask = Readonly<z.infer<typeof workspaceTemplateTaskSchema>>;
export type WorkspaceTemplateProject = Readonly<z.infer<typeof workspaceTemplateProjectSchema>>;
export type WorkspaceTemplatePlaybook = Readonly<z.infer<typeof workspaceTemplatePlaybookSchema>>;
export type WorkspaceTemplateDefinitionInput = Readonly<z.infer<typeof workspaceTemplateDefinitionInputSchema>>;
export type WorkspaceTemplateVersion = Readonly<z.infer<typeof workspaceTemplateVersionSchema>>;
export type WorkspaceTemplateInstantiation = Readonly<z.infer<typeof workspaceTemplateInstantiationSchema>>;

export function createWorkspaceTemplateId() {
  return `workspace-template:${randomUUID()}`;
}

export function buildWorkspaceTemplateVersion(input: {
  tenantId: string;
  workspaceId: string;
  templateId: string;
  version: number;
  ownerActorId: string;
  definition: z.input<typeof workspaceTemplateDefinitionInputSchema>;
  publishedAt?: string;
}): WorkspaceTemplateVersion {
  const definition = workspaceTemplateDefinitionInputSchema.parse(input.definition);
  const publishedAt = input.publishedAt || new Date().toISOString();
  const body = workspaceTemplateVersionBodySchema.parse({
    schemaVersion: WORKSPACE_TEMPLATE_SCHEMA_VERSION,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    templateId: input.templateId,
    templateVersionId: `${input.templateId}:v${input.version}`,
    version: input.version,
    ownerActorId: input.ownerActorId,
    name: definition.name,
    description: definition.description,
    project: definition.project,
    playbook: definition.playbook
      ? {
          ...definition.playbook,
          aliases: definition.playbook.aliases.map(normalizeProcedureAlias),
        }
      : null,
    previousTemplateVersionId: input.version === 1
      ? null
      : `${input.templateId}:v${input.version - 1}`,
    publishedByActorId: input.ownerActorId,
    publishedAt,
  });
  return deepFreeze(workspaceTemplateVersionSchema.parse({
    ...body,
    templateSha256: canonicalJsonSha256(body),
  }));
}

export function parseWorkspaceTemplateVersion(value: unknown) {
  const parsed = workspaceTemplateVersionSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
}

export function normalizeProcedureAlias(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasDependencyCycle(tasks: readonly z.infer<typeof workspaceTemplateTaskSchema>[]) {
  const dependencies = new Map(tasks.map((task) => [task.key, task.dependsOnKeys]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return tasks.some((task) => visit(task.key));
}

function isJsonValue(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) => Boolean(key) && isJsonValue(nested),
  );
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string|database[_-]?url|private[_-]?key/i.test(key) ||
    containsSensitiveField(nested)
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
