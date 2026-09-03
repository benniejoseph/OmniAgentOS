import type {
  ServiceApiKeyPrincipal,
  ServiceApiScope,
} from "@/lib/settings/service-api-keys";
import { resolveServiceApiKeyToken } from "@/lib/settings/service-api-keys";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { getMcpExportConfiguration } from "@/lib/settings/store";

const developmentHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class McpAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 421 | 503,
    public readonly requiredScope?: ServiceApiScope,
  ) {
    super(message);
    this.name = "McpAccessError";
  }
}

export type AuthorizedMcpPrincipal = ServiceApiKeyPrincipal & {
  serverName: string;
  exposeResources: boolean;
};

export async function authenticateMcpRequest(
  request: Request,
): Promise<AuthorizedMcpPrincipal> {
  const authorization = request.headers.get("authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) {
    throw new McpAccessError("A service API key is required.", 401);
  }

  let principal: ServiceApiKeyPrincipal | null;
  try {
    principal = await resolveServiceApiKeyToken(match[1]);
  } catch {
    throw new McpAccessError(
      "The MCP authentication service is temporarily unavailable.",
      503,
    );
  }
  if (!principal) {
    throw new McpAccessError("The service API key is invalid or revoked.", 401);
  }

  let configuration: Awaited<ReturnType<typeof getMcpExportConfiguration>>;
  try {
    configuration = await runWithDatabaseTenantScope(
      principal.tenantId,
      () =>
        getMcpExportConfiguration({
          tenantId: principal.tenantId,
          actorId: principal.actorId,
        }),
    );
  } catch {
    throw new McpAccessError(
      "The MCP export policy is temporarily unavailable.",
      503,
    );
  }
  if (!configuration.enabled) {
    throw new McpAccessError(
      "MCP access is disabled in Settings for this account.",
      403,
    );
  }

  const authorized: AuthorizedMcpPrincipal = {
    ...principal,
    scopes: principal.scopes.filter((scope) =>
      configuration.allowedScopes.includes(scope)
    ),
    serverName: configuration.serverName,
    exposeResources: configuration.exposeResources,
  };
  assertMcpScope(authorized, "mcp:discover");
  return authorized;
}

export function assertMcpScope(
  principal: ServiceApiKeyPrincipal,
  requiredScope: ServiceApiScope,
) {
  if (!principal.scopes.includes(requiredScope)) {
    throw new McpAccessError(
      `The service API key is missing the ${requiredScope} scope.`,
      403,
      requiredScope,
    );
  }
}

export function hasMcpScope(
  principal: ServiceApiKeyPrincipal,
  requiredScope: ServiceApiScope,
) {
  return principal.scopes.includes(requiredScope);
}

export function assertTrustedMcpNetworkBoundary(request: Request) {
  const allowedHosts = configuredHosts();
  const suppliedHost = normalizeHost(request.headers.get("host"));

  if (!allowedHosts.size) {
    throw new McpAccessError(
      "MCP allowed hosts are not configured for this deployment.",
      503,
    );
  }
  if (!suppliedHost || !allowedHosts.has(suppliedHost)) {
    throw new McpAccessError("The MCP request host is not allowed.", 421);
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return undefined;
  }
  const suppliedOrigin = normalizeOrigin(originHeader);
  if (!suppliedOrigin) {
    throw new McpAccessError("The MCP request origin is invalid.", 403);
  }
  const allowedOrigins = configuredOrigins();
  if (!allowedOrigins.has(suppliedOrigin)) {
    throw new McpAccessError("The MCP request origin is not allowed.", 403);
  }
  return suppliedOrigin;
}

export function mcpBearerChallenge(requiredScope?: ServiceApiScope) {
  const scope = requiredScope || "mcp:discover";
  return `Bearer realm="Asael MCP", scope="${scope}"`;
}

function configuredHosts() {
  const hosts = new Set<string>();
  for (const value of configuredNetworkValues(
    process.env.OMNIAGENT_MCP_ALLOWED_HOSTS,
  )) {
    const host = hostFromUrl(value);
    if (host) hosts.add(host);
  }
  for (const value of applicationUrls()) {
    const host = hostFromUrl(value);
    if (host) hosts.add(host);
  }
  if (process.env.NODE_ENV !== "production") {
    for (const host of developmentHosts) hosts.add(host);
    for (const host of developmentHosts) {
      for (const port of ["3000", "3001", "3002"]) {
        hosts.add(`${host}:${port}`);
      }
    }
  }
  return hosts;
}

function configuredOrigins() {
  const origins = new Set<string>();
  for (const value of configuredNetworkValues(
    process.env.OMNIAGENT_MCP_ALLOWED_ORIGINS,
  )) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }
  for (const value of applicationUrls()) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }
  if (process.env.NODE_ENV !== "production") {
    for (const host of developmentHosts) {
      for (const scheme of ["http", "https"]) {
        for (const port of ["3000", "3001", "3002"]) {
          origins.add(`${scheme}://${host}:${port}`);
        }
      }
    }
  }
  return origins;
}

function applicationUrls() {
  return [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function configuredNetworkValues(value?: string) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostFromUrl(value: string) {
  try {
    return normalizeHost(new URL(value).host);
  } catch {
    return normalizeHost(value);
  }
}

function normalizeHost(value?: string | null) {
  const normalized = value?.trim().toLowerCase().replace(/\.$/, "");
  return normalized || undefined;
}

function normalizeOrigin(value?: string | null) {
  if (!value) return undefined;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
}
