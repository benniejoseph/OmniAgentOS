import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  findPluginCatalogEntry,
  PLUGIN_CATALOG,
  type PluginCatalogEntry,
} from "@/lib/plugins/catalog";
import {
  pluginManifestSchema,
  type PluginManifest,
} from "@/lib/plugins/contracts";
import {
  createPluginInstallPreview,
  installPlugin,
  listPluginInstallations,
  pluginStorageAvailable,
  transitionPluginInstallation,
  type PluginInstallationRecord,
} from "@/lib/plugins/store";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const pluginIdentifierSchema = z.string().trim().min(3).max(120);
const pluginVersionSchema = z.string().trim().min(5).max(80);

export const pluginListServiceInputSchema = z.object({}).strict();
export const pluginPreviewServiceInputSchema = z.union([
  z.object({ manifest: pluginManifestSchema }).strict(),
  z.object({
    pluginId: pluginIdentifierSchema,
    version: pluginVersionSchema,
    manifestSha256: sha256Schema,
  }).strict(),
]);
export const pluginInstallServiceInputSchema = z.object({
  previewId: z.string().trim().min(16).max(200),
  manifestSha256: sha256Schema,
}).strict();
export const pluginLifecycleServiceInputSchema = z.object({
  installationId: z.string().trim().min(16).max(200),
  action: z.enum(["enable", "disable", "uninstall"]),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export class PluginCatalogNotFoundError extends Error {
  readonly code = "plugin_catalog_not_found";

  constructor() {
    super("The exact plugin catalog version was not found.");
    this.name = "PluginCatalogNotFoundError";
  }
}

export async function listPluginsService(
  caller: AppServiceCaller,
  input: z.input<typeof pluginListServiceInputSchema>,
) {
  pluginListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.plugins.list"),
  );
  const records = pluginStorageAvailable()
    ? await listPluginInstallations(exactOwner(caller))
    : [];
  const plugins = mergedPluginEntries(records);
  const installations = records.map((record) => record.installation);
  const enabled = installations.filter((installation) => installation.state === "enabled").length;
  const disabled = installations.filter((installation) => installation.state === "disabled").length;
  const uninstalled = installations.filter((installation) => installation.state === "uninstalled").length;
  return completeAppServiceCall(authorized, {
    schemaVersion: 1 as const,
    plugins,
    catalog: plugins.filter((plugin) => plugin.catalogSource !== "installed_manifest"),
    installations,
    summary: {
      total: plugins.length,
      catalog: PLUGIN_CATALOG.length,
      installed: enabled + disabled,
      enabled,
      disabled,
      uninstalled,
    },
    storage: pluginStorageAvailable()
      ? "canonical_database" as const
      : "catalog_only" as const,
    boundaries: {
      declarativeOnly: true as const,
      installsExecutableCode: false as const,
      storesCredentials: false as const,
      skillsUseExistingStore: true as const,
      mcpRequiresConnectionDiscoveryAndReview: true as const,
      toolsRemainGoverned: true as const,
      workflowsRemainApprovalAndIdempotencyBound: true as const,
    },
  }, { resourceCount: plugins.length });
}

export async function previewPluginService(
  caller: AppServiceCaller,
  input: z.input<typeof pluginPreviewServiceInputSchema>,
) {
  const value = pluginPreviewServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.plugins.preview"),
  );
  const manifest = manifestFromPreviewRequest(value);
  const result = await createPluginInstallPreview({
    authority: mutationAuthority(caller),
    manifest,
  });
  return completeAppServiceCall(authorized, {
    preview: result.preview,
    manifest: result.manifest,
  });
}

export async function installPluginService(
  caller: AppServiceCaller,
  input: z.input<typeof pluginInstallServiceInputSchema>,
) {
  const value = pluginInstallServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.plugins.install"),
  );
  const record = await installPlugin({
    authority: mutationAuthority(caller),
    previewId: value.previewId,
    manifestSha256: value.manifestSha256,
  });
  return completeAppServiceCall(authorized, {
    installation: record.installation,
    manifest: record.manifest,
    activation: pluginActivationProjection(record),
  });
}

export async function transitionPluginService(
  caller: AppServiceCaller,
  input: z.input<typeof pluginLifecycleServiceInputSchema>,
) {
  const value = pluginLifecycleServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract(`app.plugins.${value.action}`),
  );
  const record = await transitionPluginInstallation({
    authority: mutationAuthority(caller),
    ...value,
  });
  return completeAppServiceCall(authorized, {
    installation: record.installation,
    manifest: record.manifest,
    activation: pluginActivationProjection(record),
  });
}

function manifestFromPreviewRequest(
  value: z.infer<typeof pluginPreviewServiceInputSchema>,
): PluginManifest {
  if ("manifest" in value) return value.manifest;
  const entry = findPluginCatalogEntry(value);
  if (!entry) throw new PluginCatalogNotFoundError();
  return entry.manifest;
}

function mergedPluginEntries(records: readonly PluginInstallationRecord[]) {
  const byPlugin = new Map(records.map((record) => [record.installation.pluginId, record]));
  const catalogEntries = PLUGIN_CATALOG.map((entry) =>
    publicPluginEntry(entry, byPlugin.get(entry.pluginId))
  );
  const catalogIds = new Set(PLUGIN_CATALOG.map((entry) => entry.pluginId));
  const importedEntries = records
    .filter((record) => !catalogIds.has(record.installation.pluginId))
    .map((record) => publicImportedPluginEntry(record));
  return Object.freeze([...catalogEntries, ...importedEntries]);
}

function publicPluginEntry(entry: PluginCatalogEntry, record?: PluginInstallationRecord) {
  return Object.freeze({
    schemaVersion: 1 as const,
    catalogId: entry.catalogId,
    catalogSource: entry.source,
    pluginId: entry.pluginId,
    version: entry.version,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    manifestSha256: entry.manifestSha256,
    componentCounts: entry.componentCounts,
    trust: entry.trust,
    manifest: entry.manifest,
    installed: Boolean(record && record.installation.state !== "uninstalled"),
    status: record?.installation.state || null,
    installationId: record?.installation.installationId || null,
    revision: record?.installation.revision || null,
    installedVersion: record?.installation.pluginVersion || null,
    installedManifestSha256: record?.installation.manifestSha256 || null,
    updateAvailable: false,
    updateRequiresUninstall: Boolean(
      record &&
      record.installation.state !== "uninstalled" &&
      record.installation.manifestSha256 !== entry.manifestSha256
    ),
    activation: record ? pluginActivationProjection(record) : null,
  });
}

function publicImportedPluginEntry(record: PluginInstallationRecord) {
  return Object.freeze({
    schemaVersion: 1 as const,
    catalogId: `${record.installation.pluginId}@${record.installation.pluginVersion}`,
    catalogSource: "installed_manifest" as const,
    pluginId: record.installation.pluginId,
    version: record.installation.pluginVersion,
    name: record.installation.name,
    description: record.installation.description,
    publisher: record.installation.publisher,
    manifestSha256: record.installation.manifestSha256,
    componentCounts: {
      skills: record.manifest.skills.length,
      mcpTemplates: record.manifest.mcpTemplates.length,
      workflowTemplates: record.manifest.workflowTemplates.length,
    },
    trust: {
      declarativeOnly: true as const,
      containsExecutableCode: false as const,
      containsCredentials: false as const,
      externalConnectionsRequireReview: true as const,
      workflowTemplatesMetadataOnly: true as const,
    },
    manifest: record.manifest,
    installed: record.installation.state !== "uninstalled",
    status: record.installation.state,
    installationId: record.installation.installationId,
    revision: record.installation.revision,
    installedVersion: record.installation.pluginVersion,
    installedManifestSha256: record.installation.manifestSha256,
    updateAvailable: false,
    updateRequiresUninstall: false,
    activation: pluginActivationProjection(record),
  });
}

function pluginActivationProjection(record: PluginInstallationRecord) {
  return Object.freeze({
    pluginEnabled: record.installation.state === "enabled",
    skillsActive:
      record.installation.state === "enabled" && record.manifest.skills.length > 0,
    activeSkillCount:
      record.installation.state === "enabled" ? record.manifest.skills.length : 0,
    mcpConnected: false,
    mcpContractsReviewed: false,
    workflowTemplatesExecutable: false,
    explanation:
      record.installation.state === "enabled"
        ? "Declared Skills are available through the actor-owned Skill runtime. MCP connections and workflows still require their existing governed setup flows."
        : "Plugin templates are not active in the current lifecycle state.",
  });
}

function exactOwner(caller: AppServiceCaller) {
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  };
}

function mutationAuthority(caller: AppServiceCaller) {
  if (!caller.executionScope || !caller.idempotencyKey) {
    throw new Error("Plugin mutation requires exact execution attribution.");
  }
  return {
    ...exactOwner(caller),
    executionScope: caller.executionScope,
    idempotencyKey: caller.idempotencyKey,
  };
}
