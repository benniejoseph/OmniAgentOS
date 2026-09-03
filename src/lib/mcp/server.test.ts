import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { mcpBearerChallenge } from "@/lib/mcp/auth";
import { createAsaelMcpServer } from "@/lib/mcp/server";

describe("Asael MCP identity", () => {
  it("advertises the canonical Asael context and reads the legacy OmniAgent alias", async () => {
    const server = createAsaelMcpServer({
      keyId: "key-a",
      tenantId: "tenant-a",
      actorId: "actor-a",
      name: "Test key",
      scopes: ["mcp:discover"],
      serverName: "OmniAgent",
      exposeResources: true,
    });
    const client = new Client(
      { name: "identity-contract-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()?.name).toBe("Asael");
      expect(client.getInstructions()).toContain("Asael exposes");
      expect(client.getInstructions()).not.toContain("OmniAgent");

      const listed = await client.listResources();
      expect(
        listed.resources.map((resource) => ({
          name: resource.name,
          uri: resource.uri,
          title: resource.title,
        })),
      ).toEqual([
        {
          name: "asael-context",
          uri: "asael://context",
          title: "Asael MCP context",
        },
        {
          name: "omniagent-context",
          uri: "omniagent://context",
          title: "Asael MCP context",
        },
      ]);

      const canonical = await client.readResource({ uri: "asael://context" });
      const legacy = await client.readResource({ uri: "omniagent://context" });
      expect(canonical.contents[0]).toMatchObject({
        uri: "asael://context",
        mimeType: "application/json",
      });
      expect(legacy.contents[0]).toMatchObject({
        uri: "omniagent://context",
        mimeType: "application/json",
      });
    } finally {
      await client.close();
    }
  });

  it("uses the Asael MCP bearer realm", () => {
    expect(mcpBearerChallenge()).toBe(
      'Bearer realm="Asael MCP", scope="mcp:discover"',
    );
    expect(mcpBearerChallenge("memory:read")).toBe(
      'Bearer realm="Asael MCP", scope="memory:read"',
    );
  });
});
