import { randomUUID } from "node:crypto";
import { z } from "zod";

import { isRetiredRemoteBrowserMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PLUGIN_PREVIEW_SCHEMA_VERSION = 1 as const;
export const PLUGIN_INSTALLATION_SCHEMA_VERSION = 1 as const;
export const PLUGIN_SKILL_ID_PREFIX = "plugin.skill." as const;
export const PLUGIN_PREVIEW_TTL_MS = 15 * 60 * 1_000;

const identifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
const componentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/)
  .max(80);
const httpsUrlSchema = z.string().trim().url().max(2_048).superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isPublicHostname(url.hostname)
  ) {
    context.addIssue({
      code: "custom",
      message: "Plugin URLs must be public HTTPS URLs without credentials, query strings, or fragments.",
    });
  }
});

export const pluginSkillTemplateSchema = z.object({
  key: componentKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(500),
  instructions: z.string().trim().min(10).max(12_000),
  category: z.enum(["research", "creation", "analysis", "memory", "automation", "personal"]),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  knowledgeTags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
}).strict();

export const pluginMcpTemplateSchema = z.object({
  key: componentKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(700),
  endpoint: httpsUrlSchema,
  transport: z.literal("streamable_http"),
  authentication: z.enum(["none", "bearer"]),
  credentialSetup: z.literal("connect_after_install"),
  capabilitySummary: z.array(z.string().trim().min(1).max(240)).min(1).max(20),
}).strict().superRefine((template, context) => {
  if (isRetiredRemoteBrowserMcpEndpoint(template.endpoint)) {
    context.addIssue({
      code: "custom",
      path: ["endpoint"],
      message: "Remote-browser MCP templates are retired. Use the governed This Mac target.",
    });
  }
});

export const pluginWorkflowTemplateSchema = z.object({
  key: componentKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(700),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]),
  objectiveTemplate: z.string().trim().min(10).max(2_000),
  steps: z.array(z.string().trim().min(2).max(240)).min(1).max(30),
  requiredSkillKeys: z.array(componentKeySchema).max(30).default([]),
  requiredMcpTemplateKeys: z.array(componentKeySchema).max(30).default([]),
  metadataOnly: z.literal(true),
}).strict();

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(PLUGIN_MANIFEST_SCHEMA_VERSION),
  pluginId: identifierSchema,
  version: semverSchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(1_000),
  publisher: z.object({
    id: identifierSchema,
    name: z.string().trim().min(2).max(120),
    homepageUrl: httpsUrlSchema.optional(),
  }).strict(),
  license: z.string().trim().min(1).max(80),
  homepageUrl: httpsUrlSchema.optional(),
  skills: z.array(pluginSkillTemplateSchema).max(40).default([]),
  mcpTemplates: z.array(pluginMcpTemplateSchema).max(20).default([]),
  workflowTemplates: z.array(pluginWorkflowTemplateSchema).max(30).default([]),
}).strict().superRefine((manifest, context) => {
  if (!manifest.skills.length && !manifest.mcpTemplates.length && !manifest.workflowTemplates.length) {
    context.addIssue({ code: "custom", message: "A plugin must declare at least one component." });
  }
  requireUniqueKeys(manifest.skills, "skills", context);
  requireUniqueKeys(manifest.mcpTemplates, "mcpTemplates", context);
  requireUniqueKeys(manifest.workflowTemplates, "workflowTemplates", context);
  const skillKeys = new Set(manifest.skills.map((skill) => skill.key));
  const mcpKeys = new Set(manifest.mcpTemplates.map((template) => template.key));
  manifest.workflowTemplates.forEach((workflow, workflowIndex) => {
    requireUniqueReferences(workflow.requiredSkillKeys, ["workflowTemplates", workflowIndex, "requiredSkillKeys"], context);
    requireUniqueReferences(workflow.requiredMcpTemplateKeys, ["workflowTemplates", workflowIndex, "requiredMcpTemplateKeys"], context);
    for (const skillKey of workflow.requiredSkillKeys) {
      if (!skillKeys.has(skillKey)) {
        context.addIssue({
          code: "custom",
          path: ["workflowTemplates", workflowIndex, "requiredSkillKeys"],
          message: `Workflow references missing Skill template ${skillKey}.`,
        });
      }
    }
    for (const mcpKey of workflow.requiredMcpTemplateKeys) {
      if (!mcpKeys.has(mcpKey)) {
        context.addIssue({
          code: "custom",
          path: ["workflowTemplates", workflowIndex, "requiredMcpTemplateKeys"],
          message: `Workflow references missing MCP template ${mcpKey}.`,
        });
      }
    }
  });
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized, "utf8") > 128_000) {
    context.addIssue({ code: "custom", message: "Plugin manifest exceeds the 128 KB limit." });
  }
  if (containsCredentialMaterial(serialized)) {
    context.addIssue({
      code: "custom",
      message: "Plugin manifests cannot contain credentials, tokens, private keys, or secret values.",
    });
  }
});

export type PluginManifest = Readonly<z.infer<typeof pluginManifestSchema>>;

const pluginPreviewBodySchema = z.object({
  schemaVersion: z.literal(PLUGIN_PREVIEW_SCHEMA_VERSION),
  previewId: z.string().trim().min(16).max(200),
  pluginId: identifierSchema,
  pluginVersion: semverSchema,
  manifestSha256: sha256Schema,
  name: z.string().trim().min(2).max(120),
  publisherName: z.string().trim().min(2).max(120),
  componentCounts: z.object({
    skills: z.number().int().min(0).max(40),
    mcpTemplates: z.number().int().min(0).max(20),
    workflowTemplates: z.number().int().min(0).max(30),
  }).strict(),
  effects: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const pluginPreviewSchema = pluginPreviewBodySchema.extend({
  previewSha256: sha256Schema,
}).strict().superRefine((preview, context) => {
  const { previewSha256: _digest, ...body } = preview;
  if (canonicalJsonSha256(body) !== preview.previewSha256) {
    context.addIssue({
      code: "custom",
      path: ["previewSha256"],
      message: "Plugin preview digest does not match its immutable body.",
    });
  }
});

export type PluginPreview = Readonly<z.infer<typeof pluginPreviewSchema>>;
export type PluginInstallationState = "enabled" | "disabled" | "uninstalled";

const pluginInstallationBodySchema = z.object({
  schemaVersion: z.literal(PLUGIN_INSTALLATION_SCHEMA_VERSION),
  installationId: z.string().trim().min(16).max(200),
  pluginId: identifierSchema,
  pluginVersion: semverSchema,
  manifestSha256: sha256Schema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(1_000),
  publisher: z.object({
    id: identifierSchema,
    name: z.string().trim().min(2).max(120),
    homepageUrl: httpsUrlSchema.optional(),
  }).strict(),
  state: z.enum(["enabled", "disabled", "uninstalled"]),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  components: z.object({
    skills: z.array(z.object({
      key: componentKeySchema,
      name: z.string().trim().min(2).max(120),
      state: z.enum(["active", "disabled"]),
    }).strict()).max(40),
    mcpTemplates: z.array(z.object({
      key: componentKeySchema,
      name: z.string().trim().min(2).max(120),
      state: z.literal("connection_and_review_required"),
    }).strict()).max(20),
    workflowTemplates: z.array(z.object({
      key: componentKeySchema,
      name: z.string().trim().min(2).max(120),
      state: z.literal("metadata_only"),
    }).strict()).max(30),
  }).strict(),
  installedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const pluginInstallationSchema = pluginInstallationBodySchema.extend({
  installationSha256: sha256Schema,
}).strict().superRefine((installation, context) => {
  const { installationSha256: _digest, ...body } = installation;
  if (canonicalJsonSha256(body) !== installation.installationSha256) {
    context.addIssue({
      code: "custom",
      path: ["installationSha256"],
      message: "Plugin installation digest does not match its projection.",
    });
  }
});

export type PluginInstallation = Readonly<z.infer<typeof pluginInstallationSchema>>;

export const PLUGIN_EVENT_TYPES = Object.freeze({
  previewed: "plugin.install.previewed.v1",
  installed: "plugin.installed.v1",
  enabled: "plugin.enabled.v1",
  disabled: "plugin.disabled.v1",
  uninstalled: "plugin.uninstalled.v1",
});

export function parsePluginManifest(value: unknown): PluginManifest {
  return deepFreeze(pluginManifestSchema.parse(value));
}

export function pluginManifestSha256(manifest: PluginManifest) {
  return canonicalJsonSha256(pluginManifestSchema.parse(manifest));
}

export function buildPluginPreview(input: {
  previewId?: string;
  manifest: PluginManifest;
  createdAt?: string;
}): PluginPreview {
  const manifest = parsePluginManifest(input.manifest);
  const createdAt = input.createdAt || new Date().toISOString();
  const body = pluginPreviewBodySchema.parse({
    schemaVersion: PLUGIN_PREVIEW_SCHEMA_VERSION,
    previewId: input.previewId || `plugin-preview:${randomUUID()}`,
    pluginId: manifest.pluginId,
    pluginVersion: manifest.version,
    manifestSha256: pluginManifestSha256(manifest),
    name: manifest.name,
    publisherName: manifest.publisher.name,
    componentCounts: {
      skills: manifest.skills.length,
      mcpTemplates: manifest.mcpTemplates.length,
      workflowTemplates: manifest.workflowTemplates.length,
    },
    effects: [
      "Record this exact declarative manifest for the current tenant and actor.",
      "Install its declared Skills into the existing actor-owned Skill catalog while the Plugin is enabled.",
      "Make its MCP connection templates and workflow metadata visible while the Plugin is enabled.",
    ],
    limitations: [
      "Plugin Skills use the existing owner-scoped Skill store, are managed only by Plugin lifecycle, and cannot be edited independently.",
      "Disabling or uninstalling the Plugin deactivates its projected Skills without deleting their history.",
      "MCP entries require separate credential setup, discovery, contract review, and governed execution.",
      "Workflow entries are metadata only and do not start, approve, or execute a workflow.",
      "Plugins cannot execute code or contain credentials.",
    ],
    createdAt,
    expiresAt: new Date(new Date(createdAt).getTime() + PLUGIN_PREVIEW_TTL_MS).toISOString(),
  });
  return deepFreeze(pluginPreviewSchema.parse({
    ...body,
    previewSha256: canonicalJsonSha256(body),
  }));
}

export function buildPluginInstallation(input: {
  installationId: string;
  manifest: PluginManifest;
  state?: PluginInstallationState;
  revision?: number;
  installedAt?: string;
  updatedAt?: string;
}): PluginInstallation {
  const manifest = parsePluginManifest(input.manifest);
  const installedAt = input.installedAt || new Date().toISOString();
  const body = pluginInstallationBodySchema.parse({
    schemaVersion: PLUGIN_INSTALLATION_SCHEMA_VERSION,
    installationId: input.installationId,
    pluginId: manifest.pluginId,
    pluginVersion: manifest.version,
    manifestSha256: pluginManifestSha256(manifest),
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    state: input.state || "enabled",
    revision: input.revision || 1,
    components: {
      skills: manifest.skills.map(({ key, name }) => ({
        key,
        name,
        state: input.state && input.state !== "enabled"
          ? "disabled" as const
          : "active" as const,
      })),
      mcpTemplates: manifest.mcpTemplates.map(({ key, name }) => ({
        key,
        name,
        state: "connection_and_review_required" as const,
      })),
      workflowTemplates: manifest.workflowTemplates.map(({ key, name }) => ({
        key,
        name,
        state: "metadata_only" as const,
      })),
    },
    installedAt,
    updatedAt: input.updatedAt || installedAt,
  });
  return deepFreeze(pluginInstallationSchema.parse({
    ...body,
    installationSha256: canonicalJsonSha256(body),
  }));
}

export function parsePluginPreview(value: unknown) {
  const parsed = pluginPreviewSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
}

export function parsePluginInstallation(value: unknown) {
  const parsed = pluginInstallationSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
}

function requireUniqueKeys(
  values: readonly { key: string }[],
  path: string,
  context: z.RefinementCtx,
) {
  const keys = values.map((value) => value.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: [path], message: "Plugin component keys must be unique." });
  }
}

function requireUniqueReferences(values: readonly string[], path: (string | number)[], context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Plugin component references must be unique." });
  }
}

function containsCredentialMaterial(value: string) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,})\b/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(value) ||
    /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)["']\s*:/i.test(value);
}

function isPublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1"
  ) return false;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return !(
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 0
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
