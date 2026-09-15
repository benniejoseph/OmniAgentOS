import { beforeEach, describe, expect, it, vi } from "vitest";

const listMcpConnectors = vi.fn();
const listMcpTools = vi.fn();
const callMcpTool = vi.fn();

vi.mock("@/lib/connectors/store", () => ({ listMcpConnectors, listMcpTools }));
vi.mock("@/lib/connectors/mcp-client", () => ({ callMcpTool }));

describe("App Builder private visual evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures desktop and mobile digests without returning the signed preview URL", async () => {
    listMcpConnectors.mockResolvedValue([{ id: "playwright", name: "Playwright", endpoint: "https://omniagent-os-browser.fly.dev/mcp", status: "active" }]);
    listMcpTools.mockResolvedValue([
      { name: "browser_navigate", status: "active" },
      { name: "browser_resize", status: "active" },
      { name: "browser_take_screenshot", status: "active" },
    ]);
    callMcpTool.mockImplementation(async (input: { toolName: string }) => input.toolName === "browser_take_screenshot"
      ? { content: [{ type: "image", data: Buffer.from("private-pixels").toString("base64"), mimeType: "image/png" }] }
      : { content: [{ type: "text", text: "ok" }] });
    const { captureBuilderBrowserEvidence } = await import("@/lib/app-builder/verification");
    const previewUrl = "https://preview-example.vercel.app/?asael_preview=do-not-return";
    const protectionBypassSecret = "b".repeat(32);
    const result = await captureBuilderBrowserEvidence({ tenantId: "tenant-a", actorId: "actor-a", executionId: "verify-a", previewUrl, protectionBypassSecret });
    expect(result).toMatchObject({ status: "captured", captures: [{ viewport: "desktop", width: 1440 }, { viewport: "mobile", width: 390 }] });
    expect(JSON.stringify(result)).not.toContain(previewUrl);
    expect(result.captures.every((capture) => /^[a-f0-9]{64}$/.test(capture.screenshotSha256))).toBe(true);
    expect(callMcpTool).toHaveBeenCalledTimes(5);
    const navigation = callMcpTool.mock.calls.find(([input]) => input.toolName === "browser_navigate")?.[0];
    expect(navigation.args.url).toContain(`x-vercel-protection-bypass=${protectionBypassSecret}`);
    expect(navigation.args.url).toContain("x-vercel-set-bypass-cookie=true");
    expect(JSON.stringify(result)).not.toContain(protectionBypassSecret);
  });

  it("reports incomplete evidence when the trusted connector is absent", async () => {
    listMcpConnectors.mockResolvedValue([]);
    const { captureBuilderBrowserEvidence } = await import("@/lib/app-builder/verification");
    await expect(captureBuilderBrowserEvidence({ tenantId: "tenant-a", actorId: "actor-a", executionId: "verify-b", previewUrl: "https://preview.example.test" })).resolves.toEqual({
      status: "unavailable",
      captures: [],
      errorCode: "browser_connector_unavailable",
    });
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
