import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  install: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: <T extends (...args: never[]) => unknown>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/app-services/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/plugins")>()),
  listPluginsService: mocks.list,
  previewPluginService: mocks.preview,
  installPluginService: mocks.install,
  transitionPluginService: mocks.transition,
}));

import { GET as GETPlugins } from "@/app/api/plugins/route";
import { POST as POSTPreview } from "@/app/api/plugins/preview/route";
import { POST as POSTInstall } from "@/app/api/plugins/install/route";
import {
  DELETE as DELETEPlugin,
  PATCH as PATCHPlugin,
} from "@/app/api/plugins/[id]/route";
import { PLUGIN_CATALOG } from "@/lib/plugins/catalog";

const context = {
  tenantId: "tenant-routes",
  actorId: "route-owner@example.test",
  role: "admin",
  source: "session",
};
const catalog = PLUGIN_CATALOG[0];
const receipt = { receiptSha256: "r".repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(context);
  mocks.list.mockResolvedValue({
    data: { schemaVersion: 1, plugins: [], summary: { installed: 0 } },
    receipt,
  });
  mocks.preview.mockResolvedValue({
    data: {
      preview: {
        previewId: "plugin-preview:route-test-111111",
        manifestSha256: catalog.manifestSha256,
      },
      manifest: catalog.manifest,
    },
    receipt,
  });
  mocks.install.mockResolvedValue({
    data: { installation: { installationId: "plugin-installation:route-test" } },
    receipt,
  });
  mocks.transition.mockResolvedValue({
    data: { installation: { installationId: "plugin-installation:route-test" } },
    receipt,
  });
});

describe("Plugin API routes", () => {
  it("returns a private no-store catalog response", async () => {
    const response = await GETPlugins(new Request("http://localhost/api/plugins"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      plugins: [],
      serviceReceipt: receipt,
    });
  });

  it("previews and installs an exact curated manifest digest", async () => {
    const previewResponse = await POSTPreview(jsonRequest(
      "http://localhost/api/plugins/preview",
      {
        pluginId: catalog.pluginId,
        version: catalog.version,
        manifestSha256: catalog.manifestSha256,
      },
      "preview-route",
    ));
    expect(previewResponse.status).toBe(201);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeMutationCapability: "plugins.manage",
    }));
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "preview-route" }),
      expect.objectContaining({ manifestSha256: catalog.manifestSha256 }),
    );

    const installResponse = await POSTInstall(jsonRequest(
      "http://localhost/api/plugins/install",
      {
        previewId: "plugin-preview:route-test-111111",
        manifestSha256: catalog.manifestSha256,
      },
      "install-route",
    ));
    expect(installResponse.status).toBe(201);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeMutationCapability: "plugins.manage",
    }));
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "install-route" }),
      expect.objectContaining({ manifestSha256: catalog.manifestSha256 }),
    );
  });

  it("maps enable, disable, and uninstall to revision-fenced lifecycle calls", async () => {
    const installationId = "plugin-installation:route-test-111111";
    for (const action of ["enable", "disable"] as const) {
      const response = await PATCHPlugin(
        jsonRequest(`http://localhost/api/plugins/${installationId}`, {
          action,
          expectedRevision: 2,
        }, `${action}-route`),
        { params: Promise.resolve({ id: installationId }) },
      );
      expect(response.status).toBe(200);
      expect(mocks.authorize).toHaveBeenLastCalledWith(expect.objectContaining({
        nativeMutationCapability: "plugins.manage",
      }));
      expect(mocks.transition).toHaveBeenLastCalledWith(
        expect.objectContaining({ idempotencyKey: `${action}-route` }),
        { installationId, action, expectedRevision: 2 },
      );
    }
    const response = await DELETEPlugin(
      jsonRequest(`http://localhost/api/plugins/${installationId}`, {
        expectedRevision: 3,
      }, "uninstall-route", "DELETE"),
      { params: Promise.resolve({ id: installationId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeMutationCapability: "plugins.manage",
    }));
    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: "uninstall-route" }),
      { installationId, action: "uninstall", expectedRevision: 3 },
    );
  });

  it("rejects every Plugin mutation without an explicit Idempotency-Key", async () => {
    const preview = await POSTPreview(requestWithoutIdempotency(
      "http://localhost/api/plugins/preview",
      { pluginId: catalog.pluginId, version: catalog.version, manifestSha256: catalog.manifestSha256 },
    ));
    const install = await POSTInstall(requestWithoutIdempotency(
      "http://localhost/api/plugins/install",
      { previewId: "plugin-preview:route-test-111111", manifestSha256: catalog.manifestSha256 },
    ));
    const lifecycle = await PATCHPlugin(
      requestWithoutIdempotency(
        "http://localhost/api/plugins/plugin-installation%3Atest",
        { action: "disable", expectedRevision: 1 },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "plugin-installation:test" }) },
    );

    expect([preview.status, install.status, lifecycle.status]).toEqual([400, 400, 400]);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});

function jsonRequest(
  url: string,
  body: unknown,
  idempotencyKey: string,
  method = "POST",
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function requestWithoutIdempotency(
  url: string,
  body: unknown,
  method = "POST",
) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
