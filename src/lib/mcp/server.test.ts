import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { mcpBearerChallenge } from "@/lib/mcp/auth";
import { createAsaelMcpServer, MAX_MCP_TOOL_INPUT_ELEMENTS } from "@/lib/mcp/server";

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

describe("Asael MCP input budget", () => {
  it.each([
    ["array values", Array.from({ length: MAX_MCP_TOOL_INPUT_ELEMENTS }, () => 0)],
    ["object keys", Object.fromEntries(Array.from({ length: MAX_MCP_TOOL_INPUT_ELEMENTS }, (_, index) => [`key-${index}`, 0]))],
  ])("rejects excessive raw %s before validation or governed execution", async (_kind, padding) => {
    const server = createAsaelMcpServer({
      keyId: "key-budget",
      tenantId: "tenant-budget",
      actorId: "actor-budget",
      name: "Input budget key",
      scopes: ["mcp:discover", "mcp:tools:list", "memory:read"],
      serverName: "Asael",
      exposeResources: false,
    });
    const client = new Client(
      { name: "input-budget-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const oversized = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "small query", padding },
      });
      expect(oversized.isError).toBe(true);
      expect(oversized.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringMatching(/maximum of \d+ elements/i) }),
      ]);

      // A valid input still reaches the existing scope gate; this principal has
      // no execution grant, so the regression never performs a real tool action.
      const ordinary = await client.callTool({
        name: "knowledge_search",
        arguments: { query: "small query", limit: 2 },
      });
      expect(ordinary.isError).toBe(true);
      expect(ordinary.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("mcp:tools:execute") }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
