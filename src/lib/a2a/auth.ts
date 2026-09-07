import {
  assertTrustedMcpNetworkBoundary,
  McpAccessError,
} from "@/lib/mcp/auth";
import {
  resolveServiceApiKeyToken,
  type ServiceApiKeyPrincipal,
  type ServiceApiScope,
} from "@/lib/settings/service-api-keys";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import {
  getActiveInboundA2APeer,
  type A2APeerStoreError,
} from "@/lib/a2a/store";
import type { A2APeerRolloutV1 } from "@/lib/a2a/rollout";

export type AuthorizedA2APrincipal = ServiceApiKeyPrincipal & {
  peer: A2APeerRolloutV1;
};

export class A2AAccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 421 | 503,
    readonly requiredScope?: ServiceApiScope,
  ) {
    super(message);
    this.name = "A2AAccessError";
  }
}

export function assertTrustedA2ANetworkBoundary(request: Request) {
  try {
    return assertTrustedMcpNetworkBoundary(request);
  } catch (error) {
    if (error instanceof McpAccessError) {
      throw new A2AAccessError(error.message.replaceAll("MCP", "A2A"), error.status);
    }
    throw error;
  }
}

export async function authenticateA2ARequest(
  request: Request,
  requiredScopes: readonly ServiceApiScope[],
): Promise<AuthorizedA2APrincipal> {
  const authorization = request.headers.get("authorization")?.trim();
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new A2AAccessError("An Asael service API key is required.", 401);
  let principal: ServiceApiKeyPrincipal | null;
  try {
    principal = await resolveServiceApiKeyToken(token);
  } catch {
    throw new A2AAccessError("The A2A authentication service is temporarily unavailable.", 503);
  }
  if (!principal) throw new A2AAccessError("The service API key is invalid or revoked.", 401);
  for (const scope of requiredScopes) {
    if (!principal.scopes.includes(scope)) {
      throw new A2AAccessError(
        `The service API key is missing the ${scope} scope.`,
        403,
        scope,
      );
    }
  }
  try {
    const peer = await runWithDatabaseTenantScope(principal.tenantId, () =>
      getActiveInboundA2APeer({
        tenantId: principal!.tenantId,
        ownerActorId: principal!.actorId,
        serviceApiKeyId: principal!.keyId,
      })
    );
    return { ...principal, peer };
  } catch (error) {
    const peerError = error as A2APeerStoreError;
    if (peerError?.status === 403 || peerError?.status === 503) {
      throw new A2AAccessError(peerError.message, peerError.status);
    }
    throw new A2AAccessError("The A2A peer policy is temporarily unavailable.", 503);
  }
}

export function a2aBearerChallenge(requiredScope = "a2a:discover") {
  return `Bearer realm="Asael A2A", scope="${requiredScope}"`;
}
