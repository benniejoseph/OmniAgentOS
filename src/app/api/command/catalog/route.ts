import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listAgentsService,
  listSkillsService,
} from "@/lib/app-services/agents";
import { showTruthfulIntegrationsService } from "@/lib/app-services/integrations";
import { listWorkspaceLibraryService } from "@/lib/app-services/library";
import { listPluginsService } from "@/lib/app-services/plugins";
import { listProjectsService } from "@/lib/app-services/projects";
import type {
  CommandContextCatalog,
  CommandContextCatalogItem,
  CommandContextKind,
} from "@/lib/command/composer-context-contract";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "command_context_catalog",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const caller = createAppServiceCaller({ context });
  const [agents, skills, plugins, projects, integrations, files] = await Promise.all([
    settle("agent", () => listAgentsService(caller, { ownerScope: "readable" })),
    settle("skill", () => listSkillsService(caller, {})),
    settle("plugin", () => listPluginsService(caller, {})),
    settle("project", () => listProjectsService(caller, { limit: 80 })),
    settle("integration", () => showTruthfulIntegrationsService(caller, {})),
    settle("file", () => listWorkspaceLibraryService(caller, {
      query: "",
      kinds: [],
      limit: 60,
      offset: 0,
    })),
  ]);

  const items: CommandContextCatalogItem[] = [];

  if (agents.ok) {
    items.push(...[
      ...agents.value.data.builtIns,
      ...agents.value.data.agents,
    ].map((agent) => ({
      kind: "agent" as const,
      id: agent.id,
      label: agent.name,
      description: agent.role || agent.description || "Asael specialist",
      state: "status" in agent ? String(agent.status) : "ready",
      selectable: agent.selectable !== false && (!("status" in agent) || agent.status !== "paused"),
    })));
  }

  if (skills.ok) {
    items.push(...skills.value.data.skills.map((skill) => ({
      kind: "skill" as const,
      id: skill.id,
      label: skill.name,
      description: skill.description,
      state: skill.status,
      selectable: skill.selectable !== false && skill.status === "active",
      expectedVersion: skill.version,
    })));
  }

  if (plugins.ok) {
    items.push(...plugins.value.data.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin) => ({
        kind: "plugin" as const,
        id: plugin.installationId || plugin.pluginId,
        label: plugin.name,
        description: plugin.description,
        state: plugin.status || "installed",
        selectable: plugin.status === "enabled" && Boolean(plugin.installationId),
        expectedVersion: plugin.revision || undefined,
        bindingSha256: plugin.installedManifestSha256 || undefined,
      })));
  }

  if (projects.ok) {
    items.push(...projects.value.data.projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      label: project.title,
      description: project.objective || "Project context",
      state: project.status,
      selectable: project.status !== "archived",
    })));
  }

  if (integrations.ok) {
    items.push(...integrations.value.data.overview.installed.map((integration) => ({
      kind: "integration" as const,
      id: integration.id,
      label: integration.name,
      description: integration.permissions.mode === "no_access"
        ? integration.nextAction
        : `${friendlyPermission(integration.permissions.mode)}${integration.account?.email ? ` · ${integration.account.email}` : ""} · ${integration.nextAction}`,
      state: integration.state,
      selectable: integration.connected && integration.state !== "unavailable",
    })));
  }

  if (files.ok) {
    items.push(...files.value.data.items.map((file) => ({
      kind: "file" as const,
      id: file.id,
      label: file.title,
      description: file.status === "ready"
        ? `${file.sourceLabel} · ${file.summary || "Ready as command context"}`
        : file.status === "failed"
          ? "Processing failed · open its source to retry"
          : "Still processing in Library",
      state: file.status,
      selectable: file.status === "ready",
      sourceId: file.sourceId,
      expectedVersion: file.currentVersion.versionNumber,
      versionId: file.currentVersion.versionId,
      bindingSha256: file.currentVersion.contentSha256,
    })));
  }

  const catalog: CommandContextCatalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: items.toSorted((left, right) =>
      left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label)
    ),
    sources: {
      agent: sourceState(agents),
      skill: sourceState(skills),
      plugin: sourceState(plugins),
      project: sourceState(projects),
      integration: sourceState(integrations),
      file: sourceState(files),
    },
  };

  return Response.json(catalog, {
    headers: { "cache-control": "private, no-store" },
  });
}

type Settled<T> = Readonly<
  | { ok: true; value: T }
  | { ok: false; source: CommandContextKind }
>;

async function settle<T>(
  source: CommandContextKind,
  load: () => Promise<T>,
): Promise<Settled<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    console.warn("Command context catalog source unavailable.", {
      source,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { ok: false, source };
  }
}

function sourceState<T>(source: Settled<T>) {
  return source.ok ? "ready" as const : "unavailable" as const;
}

function friendlyPermission(mode: string) {
  return ({
    read_only: "Read only",
    read_write: "Read and write",
    write_approval_required: "Writes need approval",
    unclassified: "Access under review",
  } as Record<string, string>)[mode] || "Connected";
}
