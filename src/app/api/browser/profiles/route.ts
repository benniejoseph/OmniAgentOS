import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createBrowserProfile,
  listBrowserProfiles,
} from "@/lib/browser/profiles";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  allowedDomains: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
}).strict();
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "browser_profile",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const profiles = await listBrowserProfiles({
    tenantId: context.tenantId,
    ownerActorId: context.actorId,
  });
  return Response.json({ profiles: profiles.map(publicBrowserProfile) }, {
    headers: privateNoStoreHeaders,
  });
}

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "browser_profile",
      metadata: { operation: "consent" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid browser profile.", details: parsed.error.flatten() }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  try {
    const correlationId = request.headers.get("x-request-id")?.trim() || randomUUID();
    const profile = await createBrowserProfile({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      ...parsed.data,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId,
        purpose: "browser.profile.consent",
      }),
    });
    return Response.json({ profile: publicBrowserProfile(profile) }, {
      status: 201,
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Browser profile could not be created.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
}

function publicBrowserProfile(profile: Awaited<ReturnType<typeof createBrowserProfile>>) {
  return {
    id: profile.id,
    name: profile.name,
    allowedDomains: profile.allowedDomains,
    state: profile.state,
    lifecycleRevision: profile.lifecycleRevision,
    consentedAt: profile.consentedAt,
    lastUsedAt: profile.lastUsedAt,
    revokedAt: profile.revokedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
