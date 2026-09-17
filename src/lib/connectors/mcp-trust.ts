import { ASAEL_PUBLIC_ORIGIN } from "@/lib/identity";

/**
 * Retained only as deny-list coordinates while existing records are retired.
 * These endpoints are not supported connector presets or execution targets.
 */
export const ASAEL_PLAYWRIGHT_MCP_ENDPOINT =
  `${ASAEL_PUBLIC_ORIGIN}/api/integrations/playwright/mcp`;
export const LEGACY_PLAYWRIGHT_MCP_ENDPOINT =
  "https://omniagent-os-browser.fly.dev/mcp";

export const RETIRED_REMOTE_BROWSER_MCP_MESSAGE =
  "Remote browser automation MCP is retired. Use the governed installed-Mac Computer Use target instead.";

export function isOfficialGitHubMcpEndpoint(endpoint?: string) {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.githubcopilot.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
    );
  } catch {
    return false;
  }
}

export function isOfficialBrowserUseMcpEndpoint(endpoint?: string) {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.browser-use.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function isRetiredRemoteBrowserMcpEndpoint(endpoint?: string) {
  return isOfficialBrowserUseMcpEndpoint(endpoint) ||
    isAsaelPlaywrightMcpEndpoint(endpoint);
}

export function assertMcpEndpointIsSupported(endpoint?: string) {
  if (isRetiredRemoteBrowserMcpEndpoint(endpoint)) {
    throw new Error(RETIRED_REMOTE_BROWSER_MCP_MESSAGE);
  }
}

export function assertMcpConnectorIsSupported(input: {
  name?: string;
  endpoint?: string;
}) {
  assertMcpEndpointIsSupported(input.endpoint);
  if (isRemoteBrowserMcpIdentity(input)) {
    throw new Error(RETIRED_REMOTE_BROWSER_MCP_MESSAGE);
  }
}

export function isRemoteBrowserMcpIdentity(input: {
  name?: string;
  endpoint?: string;
}) {
  if (isRetiredRemoteBrowserMcpEndpoint(input.endpoint)) return true;
  const identity = normalizeSignal(input.name);
  return /(?:^|[._:/\s-])(?:browser|playwright|chromium|webdriver|puppeteer|computer[\s._-]*use|remote[\s._-]*desktop)(?:$|[._:/\s-])/i
    .test(identity);
}

/**
 * Remote MCP metadata is untrusted. This detector can only quarantine tools;
 * no remote annotation, title, or description can opt a matching tool back in.
 */
export function isRemoteBrowserMcpTool(tool: {
  name?: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}) {
  const name = normalizeSignal(tool.name);
  if (!name) return false;
  if (
    /(?:^|[._:/-])(?:browser|playwright|chromium|webdriver|puppeteer|cdp|computer[._-]*use|remote[._-]*desktop)(?:$|[._:/-])/i
      .test(name)
  ) {
    return true;
  }

  const signals = collectMetadataSignals(tool);
  const hasBrowserSurface =
    /\b(?:browser|webpage|web page|page dom|dom selector|css selector|xpath|tab|chromium|playwright|webdriver|puppeteer|accessibility snapshot|remote desktop|screen coordinates?)\b/i
      .test(signals);
  const hasControlAction =
    /\b(?:navigate|click|type text|type into|fill|press key|hover|drag|scroll|select option|handle dialog|take screenshot|capture screen|snapshot|upload file|evaluate javascript|run code|open url|mouse|keyboard)\b/i
      .test(signals);
  return hasBrowserSurface && hasControlAction;
}

export function isAsaelPlaywrightMcpEndpoint(endpoint?: string) {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password
    ) return false;
    if (url.hostname === "omniagent-os-browser.fly.dev") return true;
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return normalized === ASAEL_PLAYWRIGHT_MCP_ENDPOINT;
  } catch {
    return false;
  }
}

function collectMetadataSignals(value: unknown) {
  const parts: string[] = [];
  const queue: unknown[] = [value];
  let visited = 0;
  let bytes = 0;
  while (queue.length && visited < 1_000 && bytes < 32_000) {
    const current = queue.shift();
    visited += 1;
    if (typeof current === "string") {
      const signal = normalizeMetadataSignal(current).slice(0, 1_000);
      parts.push(signal);
      bytes += signal.length;
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current.slice(0, 100));
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, item] of Object.entries(current as Record<string, unknown>).slice(0, 100)) {
      const signal = normalizeMetadataSignal(key).slice(0, 240);
      parts.push(signal);
      bytes += signal.length;
      queue.push(item);
    }
  }
  return parts.join(" ").slice(0, 32_000);
}

function normalizeSignal(value?: string) {
  return (value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
}

function normalizeMetadataSignal(value?: string) {
  return normalizeSignal(value)
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ");
}
