import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.security",
      resourceType: "database_schema",
      riskLevel: 3,
      metadata: { trigger: "controlled_release_migration" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (context.role !== "system") {
    return Response.json(
      { error: "Database migrations require system authentication." },
      { status: 403 },
    );
  }

  return Response.json(
    {
      error: "Request-bound migrations are disabled.",
      message:
        "Run `npm run db:migrate` from a dedicated release job with MIGRATION_DATABASE_URL.",
    },
    { status: 410 },
  );
}
