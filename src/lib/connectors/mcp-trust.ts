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
