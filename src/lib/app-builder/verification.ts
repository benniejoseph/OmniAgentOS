import "server-only";

import { createHash } from "node:crypto";
import { callMcpTool, type McpSessionScope } from "@/lib/connectors/mcp-client";
import { isAsaelPlaywrightMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { listMcpConnectors, listMcpTools } from "@/lib/connectors/store";
import type { AppBuilderVerification } from "@/lib/app-builder/contracts";

const requiredBrowserTools = ["browser_navigate", "browser_resize", "browser_take_screenshot"] as const;
const viewports = [
  { viewport: "desktop" as const, width: 1440, height: 960 },
  { viewport: "mobile" as const, width: 390, height: 844 },
] as const;

export async function captureBuilderBrowserEvidence(input: {
  tenantId: string;
  actorId: string;
  executionId: string;
  previewUrl: string;
  protectionBypassSecret?: string;
}): Promise<AppBuilderVerification["browserEvidence"]> {
  const connectors = await listMcpConnectors(50, { tenantId: input.tenantId });
  const connector = connectors.find((candidate) =>
    candidate.status === "active" && isAsaelPlaywrightMcpEndpoint(candidate.endpoint)
  );
  if (!connector) return { status: "unavailable", captures: [], errorCode: "browser_connector_unavailable" };
  const tools = await listMcpTools(connector.id, { tenantId: input.tenantId });
  const activeNames = new Set(tools.filter((tool) => tool.status === "active").map((tool) => tool.name));
  if (requiredBrowserTools.some((name) => !activeNames.has(name))) {
    return { status: "unavailable", captures: [], errorCode: "browser_tools_unavailable" };
  }
  const sessionScope: McpSessionScope = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    executionId: input.executionId,
  };
  try {
    const captures: AppBuilderVerification["browserEvidence"]["captures"][number][] = [];
    for (const viewport of viewports) {
      await callMcpTool({
        connector,
        toolName: "browser_resize",
        args: { width: viewport.width, height: viewport.height },
        idempotencyKey: `${input.executionId}:${viewport.viewport}:resize`,
        sessionScope,
      });
      if (viewport.viewport === "desktop") {
        await callMcpTool({
          connector,
          toolName: "browser_navigate",
          args: { url: browserNavigationUrl(input.previewUrl, input.protectionBypassSecret) },
          idempotencyKey: `${input.executionId}:navigate`,
          sessionScope,
        });
      }
      const result = await callMcpTool({
        connector,
        toolName: "browser_take_screenshot",
        args: { type: "png", fullPage: true },
        idempotencyKey: `${input.executionId}:${viewport.viewport}:screenshot`,
        sessionScope,
        includeImages: true,
      });
      const image = firstImageBlock(result);
      if (!image) throw new Error("Browser capture did not contain an image.");
      const bytes = Buffer.from(image.data, "base64");
      if (!bytes.byteLength) throw new Error("Browser capture was empty.");
      captures.push({
        ...viewport,
        screenshotSha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: image.mimeType,
        byteLength: bytes.byteLength,
      });
    }
    return { status: "captured", captures };
  } catch (error) {
    return {
      status: "failed",
      captures: [],
      errorCode: `browser_${createHash("sha256").update(error instanceof Error ? error.message : "unknown").digest("hex").slice(0, 12)}`,
    };
  }
}

function browserNavigationUrl(previewUrl: string, protectionBypassSecret?: string) {
  if (!protectionBypassSecret) return previewUrl;
  if (!/^[A-Za-z0-9]{32}$/.test(protectionBypassSecret)) {
    throw new Error("The Vercel protection bypass token is invalid.");
  }
  const url = new URL(previewUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app")) {
    throw new Error("Protected browser evidence requires an exact Vercel preview URL.");
  }
  url.searchParams.set("x-vercel-protection-bypass", protectionBypassSecret);
  url.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return url.toString();
}

function firstImageBlock(value: unknown): { data: string; mimeType: string } | undefined {
  const queue: unknown[] = [value];
  let inspected = 0;
  while (queue.length && inspected < 2_000) {
    inspected += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
        return { data: record.data, mimeType: record.mimeType };
      }
      queue.push(...Object.values(record));
    } else {
      queue.push(...current);
    }
  }
  return undefined;
}
