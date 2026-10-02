import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

const internalSecret = "internal-tenant-smoke-secret";
const connectorId = "mcp_tenant_smoke";
const connectorPath = `/api/connectors/${connectorId}`;
const workflowId = "run_tenant_smoke";
const trashId = "trash:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const purgePath = `/api/trash/${encodeURIComponent(trashId)}/purge`;
const trashPreview = {
  version: "p9.3-trash-preview:1",
  action: "trash",
  trashId: null,
  resourceType: "mcp_connector",
  resourceId: connectorId,
  lifecycleRevision: 0,
  targetSha256: "a".repeat(64),
  effectSummary: "Move MCP connector Smoke and 0 contract(s) to trash.",
  reversible: true,
  issuedAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-10-02T00:10:00.000Z",
  previewSha256: "b".repeat(64),
};
const purgePreview = {
  ...trashPreview,
  action: "purge",
  trashId,
  lifecycleRevision: 1,
  effectSummary: "Permanently delete the connector.",
  reversible: false,
  previewSha256: "c".repeat(64),
};

type TenantSmokeServerOptions = {
  tenantBCanPreview?: boolean;
  previewAction?: string;
  previewResourceId?: string;
  movedToTrash?: boolean;
  purgedState?: string;
  purgedTrashId?: string;
};

type ObservedRequests = {
  requests: string[];
  deleteBodies: Array<{ tenant: string; body: Record<string, unknown> }>;
  purgeBody?: Record<string, unknown>;
  connectorTrashed: boolean;
  connectorPurged: boolean;
};

describe("tenant isolation release smoke", () => {
  it("deletes through the Trash preview, keeps tenant B out, and purges the connector", async () => {
    await withTenantSmokeServer({}, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(0);
      expect(output).not.toContain("FAIL");
      expect(
        observed.requests.filter((entry) => entry.includes("/api/connectors/") || entry.includes("/api/trash/")),
      ).toEqual([
        `B PATCH ${connectorPath}`,
        `A PATCH ${connectorPath}`,
        `B POST ${connectorPath}`,
        `A POST ${connectorPath}`,
        `B DELETE ${connectorPath}`,
        `A DELETE ${connectorPath}`,
        `A GET ${purgePath}`,
        `A DELETE ${purgePath}`,
      ]);
      expect(observed.deleteBodies).toEqual([
        { tenant: "B", body: { preview: trashPreview } },
        { tenant: "A", body: { preview: trashPreview } },
      ]);
      expect(observed.purgeBody).toEqual({ preview: purgePreview });
      expect(observed.connectorPurged).toBe(true);
    });
  });

  it("fails when tenant B can preview deleting tenant A's connector", async () => {
    await withTenantSmokeServer({ tenantBCanPreview: true }, async (baseUrl) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(1);
      expect(output).toContain("FAIL tenant B cannot preview deleting tenant A connector");
      expect(output).toContain("PASS tenant B cannot delete tenant A connector");
    });
  });

  it.each([
    { previewResourceId: "mcp_other" },
    { previewAction: "restore" },
  ])("fails when the delete preview is not a trash move of the connector (%o)", async (options) => {
    await withTenantSmokeServer(options, async (baseUrl) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(1);
      expect(output).toContain("FAIL tenant A can preview deleting its connector");
    });
  });

  it("fails when the connector delete does not report a move to trash", async () => {
    await withTenantSmokeServer({ movedToTrash: false }, async (baseUrl) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(1);
      expect(output).toContain("FAIL synthetic connector is moved to trash after isolation checks");
    });
  });

  it.each([
    { purgedState: "retained" },
    { purgedTrashId: "trash:00000000-0000-4000-8000-000000000000" },
  ])("fails when the trashed connector is not confirmed purged (%o)", async (options) => {
    await withTenantSmokeServer(options, async (baseUrl, observed) => {
      const result = await runProcess(baseUrl);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code, output).toBe(1);
      expect(observed.connectorTrashed).toBe(true);
      expect(output).toContain("PASS synthetic connector is moved to trash after isolation checks");
      expect(output).toContain("FAIL synthetic connector is purged after isolation checks");
    });
  });
});

async function withTenantSmokeServer(
  options: TenantSmokeServerOptions,
  callback: (baseUrl: string, observed: ObservedRequests) => Promise<void>,
) {
  const observed: ObservedRequests = {
    requests: [],
    deleteBodies: [],
    connectorTrashed: false,
    connectorPurged: false,
  };
  const server = createServer((request, response) => {
    handleRequest(request, response, options, observed).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Tenant smoke test server did not expose a TCP address.");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}`, observed);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: TenantSmokeServerOptions,
  observed: ObservedRequests,
) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const method = request.method || "GET";
  const tenantHeader = String(request.headers["x-omni-tenant-id"] || "");
  const tenant = tenantHeader.startsWith("smoke_tenant_a_")
    ? "A"
    : tenantHeader.startsWith("smoke_tenant_b_") ? "B" : "?";
  observed.requests.push(`${tenant} ${method} ${url.pathname}`);
  if (request.headers["x-omni-internal-auth"] !== internalSecret) {
    return json(response, 401, { error: "Authentication required." });
  }
  if (method !== "GET" && !request.headers["idempotency-key"]) {
    return json(response, 400, { error: "Idempotency-Key is required." });
  }
  const body = method === "GET" ? {} : await readJsonBody(request);
  const owner = tenant === "A";

  if (url.pathname === "/api/connectors") {
    return method === "POST"
      ? json(response, 201, { connector: { id: connectorId, status: "active" } })
      : json(response, 200, { connectors: owner ? [{ id: connectorId }] : [] });
  }
  if (url.pathname === connectorPath) {
    if (method === "PATCH") {
      return owner
        ? json(response, 200, { connector: { id: connectorId, status: body.status } })
        : json(response, 404, { error: "MCP connector not found." });
    }
    if (method === "POST") {
      if (!owner && !options.tenantBCanPreview) {
        return json(response, 404, { error: "MCP connector not found." });
      }
      return json(response, 200, {
        target: { kind: "mcp" },
        preview: {
          ...trashPreview,
          action: options.previewAction ?? "trash",
          resourceId: options.previewResourceId ?? connectorId,
        },
        reversible: true,
      });
    }
    if (method === "DELETE") {
      observed.deleteBodies.push({ tenant, body });
      const preview = body.preview;
      if (!preview || typeof preview !== "object") {
        return json(response, 409, { error: "Invalid input: expected object, received undefined" });
      }
      if (!owner) {
        return json(response, 404, { error: "Connector not found." });
      }
      if ((preview as Record<string, unknown>).resourceId !== connectorId) {
        return json(response, 409, { error: "Trash preview targets a different resource." });
      }
      observed.connectorTrashed = true;
      return json(response, 200, {
        movedToTrash: options.movedToTrash ?? true,
        trash: { trashId, resourceId: connectorId, state: "retained" },
      });
    }
  }
  if (url.pathname === purgePath && owner && observed.connectorTrashed) {
    if (method === "GET") {
      return json(response, 200, { preview: purgePreview });
    }
    if (method === "DELETE") {
      observed.purgeBody = body;
      const preview = body.preview as Record<string, unknown> | undefined;
      if (preview?.previewSha256 !== purgePreview.previewSha256) {
        return json(response, 409, { error: "Purge preview targets a different trash item." });
      }
      const state = options.purgedState ?? "purged";
      const purgedTrashId = options.purgedTrashId ?? trashId;
      observed.connectorPurged = state === "purged" && purgedTrashId === trashId;
      return json(response, 200, { trash: { trashId: purgedTrashId, state } });
    }
  }
  if (url.pathname === "/api/observability") {
    return method === "POST"
      ? json(response, 201, { event: { id: "event_tenant_marker" } })
      : json(response, 200, { events: [] });
  }
  if (url.pathname === "/api/workflows") {
    return method === "POST"
      ? json(response, 201, { run: { id: workflowId } })
      : json(response, 200, { runs: [] });
  }
  if (url.pathname === `/api/workflows/${workflowId}/signal`) {
    return json(response, 200, { run: { id: workflowId, status: "canceled" } });
  }
  return json(response, 404, { error: "Not found." });
}

function runProcess(baseUrl: string) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke-tenant-isolation.mjs"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        SMOKE_INTERNAL_AUTH_SECRET: internalSecret,
        OMNIAGENT_INTERNAL_AUTH_SECRET: internalSecret,
        VERCEL_AUTOMATION_BYPASS_SECRET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
