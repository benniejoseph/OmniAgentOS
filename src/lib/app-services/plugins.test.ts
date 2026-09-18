import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  install: vi.fn(),
  transition: vi.fn(),
  storageAvailable: vi.fn(() => true),
}));

vi.mock("@/lib/plugins/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/store")>()),
  listPluginInstallations: mocks.list,
  createPluginInstallPreview: mocks.preview,
  installPlugin: mocks.install,
  transitionPluginInstallation: mocks.transition,
  pluginStorageAvailable: mocks.storageAvailable,
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  installPluginService,
  listPluginsService,
  PluginCatalogNotFoundError,
  previewPluginService,
  transitionPluginService,
} from "@/lib/app-services/plugins";
import { PLUGIN_CATALOG } from "@/lib/plugins/catalog";
import {
  buildPluginInstallation,
  buildPluginPreview,
} from "@/lib/plugins/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const context = {
  tenantId: "tenant-plugin",
  actorId: "plugin-owner@example.test",
  role: "admin",
  source: "session",
} satisfies SecurityContext;
const catalog = PLUGIN_CATALOG[0];
const manifest = catalog.manifest;
const preview = buildPluginPreview({
  previewId: "plugin-preview:service-test-111111",
  manifest,
  createdAt: "2026-09-18T10:00:00.000Z",
});
const installation = buildPluginInstallation({
  installationId: "plugin-installation:service-test-111111",
  manifest,
  installedAt: "2026-09-18T10:01:00.000Z",
});
const record = { installation, manifest };

function caller(purpose?: string) {
  return createAppServiceCaller({
    context,
    ...(purpose ? {
      idempotencyKey: `plugin-${purpose}`,
      executionScope: createExecutionScope({
        tenantId: context.tenantId,
        initiatingActorId: context.actorId,
        executingPrincipalType: "user",
        executingPrincipalId: context.actorId,
        correlationId: `plugin-${purpose}`,
        purpose,
      }),
    } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storageAvailable.mockReturnValue(true);
  mocks.list.mockResolvedValue([record]);
  mocks.preview.mockResolvedValue({ preview, manifest });
  mocks.install.mockResolvedValue(record);
  mocks.transition.mockResolvedValue(record);
});

describe("Plugin application service", () => {
  it("lists UI-friendly catalog entries with explicit activation truth", async () => {
    const result = await listPluginsService(caller(), {});
    expect(mocks.list).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(result.receipt.operation).toBe("app.plugins.list");
    expect(result.data).toMatchObject({
      schemaVersion: 1,
      summary: { installed: 1, enabled: 1 },
      boundaries: {
        declarativeOnly: true,
        storesCredentials: false,
        toolsRemainGoverned: true,
      },
    });
    expect(result.data.plugins[0]).toMatchObject({
      pluginId: manifest.pluginId,
      manifestSha256: catalog.manifestSha256,
      installed: true,
      status: "enabled",
      updateAvailable: false,
      updateRequiresUninstall: false,
      activation: {
        skillsActive: true,
        activeSkillCount: 1,
        mcpConnected: false,
        workflowTemplatesExecutable: false,
      },
    });
  });

  it("does not advertise an unsupported in-place Plugin update", async () => {
    const priorManifest = {
      ...manifest,
      version: "0.9.0",
      description: "An earlier declarative repository workflow bundle.",
    };
    const priorInstallation = buildPluginInstallation({
      installationId: installation.installationId,
      manifest: priorManifest,
      installedAt: installation.installedAt,
    });
    mocks.list.mockResolvedValue([{
      installation: priorInstallation,
      manifest: priorManifest,
    }]);

    const result = await listPluginsService(caller(), {});

    expect(result.data.plugins[0]).toMatchObject({
      installed: true,
      installedVersion: "0.9.0",
      updateAvailable: false,
      updateRequiresUninstall: true,
    });
  });

  it("previews only the exact curated catalog digest when coordinates are used", async () => {
    const result = await previewPluginService(caller("plugin.preview"), {
      pluginId: catalog.pluginId,
      version: catalog.version,
      manifestSha256: catalog.manifestSha256,
    });
    expect(mocks.preview).toHaveBeenCalledWith({
      authority: expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        idempotencyKey: "plugin-plugin.preview",
      }),
      manifest,
    });
    expect(result.data.preview.manifestSha256).toBe(catalog.manifestSha256);
    await expect(previewPluginService(caller("plugin.preview"), {
      pluginId: catalog.pluginId,
      version: catalog.version,
      manifestSha256: "f".repeat(64),
    })).rejects.toBeInstanceOf(PluginCatalogNotFoundError);
  });

  it("installs only an exact preview and reports active Skills without implying MCP authority", async () => {
    const result = await installPluginService(caller("plugin.install"), {
      previewId: preview.previewId,
      manifestSha256: preview.manifestSha256,
    });
    expect(mocks.install).toHaveBeenCalledWith({
      authority: expect.objectContaining({ idempotencyKey: "plugin-plugin.install" }),
      previewId: preview.previewId,
      manifestSha256: preview.manifestSha256,
    });
    expect(result.data.activation).toMatchObject({
      pluginEnabled: true,
      skillsActive: true,
      activeSkillCount: manifest.skills.length,
      mcpConnected: false,
      mcpContractsReviewed: false,
      workflowTemplatesExecutable: false,
    });
  });

  it.each(["enable", "disable", "uninstall"] as const)(
    "routes %s through an exact scoped lifecycle mutation",
    async (action) => {
      await transitionPluginService(caller(`plugin.${action}`), {
        installationId: installation.installationId,
        action,
        expectedRevision: installation.revision,
      });
      expect(mocks.transition).toHaveBeenCalledWith({
        authority: expect.objectContaining({
          executionScope: expect.objectContaining({ purpose: `plugin.${action}` }),
        }),
        installationId: installation.installationId,
        action,
        expectedRevision: installation.revision,
      });
    },
  );
});
