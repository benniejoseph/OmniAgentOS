import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMcpToolId,
  getMcpToolById,
  saveMcpConnector,
  saveMcpTool,
  searchActiveMcpToolMetadata,
} from "@/lib/connectors/store";
import {
  createOpenApiToolId,
  getOpenApiOperationById,
  saveOpenApiConnector,
  saveOpenApiOperation,
  searchActiveOpenApiOperationMetadata,
} from "@/lib/connectors/openapi-store";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";
import type {
  OpenApiConnectorRecord,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";

describe("progressive connector discovery", () => {
  it("searches active tenant metadata without schemas and hydrates exact contracts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "asael-progressive-tools-"));
    const previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = dataDirectory;
    delete process.env.DATABASE_URL;

    try {
      const mcpConnector = mcpConnectorRecord();
      const mcpTool = mcpToolRecord(mcpConnector);
      await saveMcpConnector(mcpConnector);
      await saveMcpTool(mcpTool);
      await saveMcpConnector(mcpConnectorRecord({
        id: "disabled-mcp",
        status: "disabled",
      }));
      await saveMcpTool(mcpToolRecord(mcpConnectorRecord({
        id: "disabled-mcp",
        status: "disabled",
      })));
      await saveMcpConnector(mcpConnectorRecord({
        id: "other-tenant-mcp",
        tenantId: "tenant-b",
      }));
      await saveMcpTool(mcpToolRecord(mcpConnectorRecord({
        id: "other-tenant-mcp",
        tenantId: "tenant-b",
      })));

      const mcpMetadata = await searchActiveMcpToolMetadata({
        tenantId: "tenant-a",
        query: "mail",
      });
      expect(mcpMetadata.map((item) => item.id)).toEqual([mcpTool.id]);
      expect(mcpMetadata[0]).not.toHaveProperty("inputSchema");
      expect(mcpMetadata[0]).not.toHaveProperty("annotations");
      await expect(getMcpToolById(mcpTool.id, { tenantId: "tenant-a" }))
        .resolves.toMatchObject({ inputSchema: mcpTool.inputSchema });
      await expect(getMcpToolById(mcpTool.id, { tenantId: "tenant-b" }))
        .resolves.toBeNull();

      for (let index = 0; index < 30; index += 1) {
        await saveMcpTool(mcpToolRecord(mcpConnector, {
          name: `generic_operation_${index}`,
          description: "Please use this generic connector operation.",
          updatedAt: `2026-08-26T00:${String(index).padStart(2, "0")}:00.000Z`,
        }));
      }
      const calendarDigest = mcpToolRecord(mcpConnector, {
        name: "summarize_calendar_digest",
        description: "Summarize the calendar into a daily digest.",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      await saveMcpTool(calendarDigest);
      await expect(searchActiveMcpToolMetadata({
        tenantId: "tenant-a",
        query: "please use the calendar digest",
        limit: 1,
      })).resolves.toEqual([
        expect.objectContaining({ id: calendarDigest.id }),
      ]);

      const openApiConnector = openApiConnectorRecord();
      const operation = openApiOperationRecord(openApiConnector);
      await saveOpenApiConnector(openApiConnector);
      await saveOpenApiOperation(operation);
      await saveOpenApiConnector(openApiConnectorRecord({
        id: "disabled-openapi",
        status: "disabled",
      }));
      await saveOpenApiOperation(openApiOperationRecord(openApiConnectorRecord({
        id: "disabled-openapi",
        status: "disabled",
      })));

      const openApiMetadata = await searchActiveOpenApiOperationMetadata({
        tenantId: "tenant-a",
        query: "message",
      });
      expect(openApiMetadata.map((item) => item.id)).toEqual([operation.id]);
      expect(openApiMetadata[0]).not.toHaveProperty("inputSchema");
      expect(openApiMetadata[0]).not.toHaveProperty("path");
      await expect(getOpenApiOperationById(operation.id, { tenantId: "tenant-a" }))
        .resolves.toMatchObject({ inputSchema: operation.inputSchema });
    } finally {
      if (previousDataDirectory === undefined) {
        delete process.env.OMNIAGENT_DATA_DIR;
      } else {
        process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

function mcpConnectorRecord(
  overrides: Partial<McpConnectorRecord> = {},
): McpConnectorRecord {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    id: "mail-mcp",
    tenantId: "tenant-a",
    name: "Mail",
    endpoint: "https://mail.example.test/mcp",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 1,
    approvalRequired: false,
    toolCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mcpToolRecord(
  connector: McpConnectorRecord,
  overrides: Partial<McpToolRecord> = {},
): McpToolRecord {
  const now = "2026-08-26T00:00:00.000Z";
  const name = overrides.name || "send_mail";
  return {
    id: overrides.id || createMcpToolId(connector.id, name),
    tenantId: connector.tenantId,
    connectorId: connector.id,
    connectorName: connector.name,
    name,
    description: "Send a mail message.",
    inputSchema: {
      type: "object",
      properties: { recipient: { type: "string" } },
    },
    riskLevel: 1,
    approvalRequired: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function openApiConnectorRecord(
  overrides: Partial<OpenApiConnectorRecord> = {},
): OpenApiConnectorRecord {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    id: "mail-openapi",
    tenantId: "tenant-a",
    name: "Mail API",
    baseUrl: "https://mail.example.test/v1",
    authType: "none",
    status: "active",
    defaultRiskLevel: 2,
    approvalRequired: true,
    operationCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function openApiOperationRecord(
  connector: OpenApiConnectorRecord,
): OpenApiOperationRecord {
  const now = "2026-08-26T00:00:00.000Z";
  const operationId = "send_message";
  return {
    id: createOpenApiToolId(connector.id, operationId),
    tenantId: connector.tenantId,
    connectorId: connector.id,
    connectorName: connector.name,
    operationId,
    method: "POST",
    path: "/messages",
    summary: "Send message",
    inputSchema: {
      type: "object",
      properties: { recipient: { type: "string" } },
    },
    responseContentTypes: ["application/json"],
    riskLevel: 2,
    approvalRequired: true,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}
