import { ASAEL_PUBLIC_ORIGIN } from "@/lib/identity";

export const ASAEL_PLAYWRIGHT_MCP_ENDPOINT =
  `${ASAEL_PUBLIC_ORIGIN}/api/integrations/playwright/mcp`;
export const LEGACY_PLAYWRIGHT_MCP_ENDPOINT =
  "https://omniagent-os-browser.fly.dev/mcp";

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
      url.password === "" &&
      (
        url.pathname === "/v3/mcp" ||
        url.pathname === "/v3/mcp/" ||
        url.pathname === "/mcp" ||
        url.pathname === "/mcp/"
      )
    );
  } catch {
    return false;
  }
}

export function isAsaelPlaywrightMcpEndpoint(endpoint?: string) {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return false;
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return normalized === ASAEL_PLAYWRIGHT_MCP_ENDPOINT ||
      normalized === LEGACY_PLAYWRIGHT_MCP_ENDPOINT;
  } catch {
    return false;
  }
}
