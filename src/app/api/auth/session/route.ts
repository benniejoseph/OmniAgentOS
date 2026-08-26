import { resolveWorkspaceSession } from "@/lib/auth/workspace-session";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { measureRequestStage } from "@/lib/observability/request-timing";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const session = await measureRequestStage("auth", () =>
    resolveWorkspaceSession(request)
  );
  return Response.json(session);
}
