import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { hasOpenAIKey } from "@/lib/config";
import { AsyncTtlCache } from "@/lib/performance/async-ttl-cache";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const databaseReadinessCache = new AsyncTtlCache<boolean>(15_000, 1);

async function GETHandler(request: Request) {
  const startedAt = Date.now();
  const publicSummary =
    new URL(request.url).searchParams.get("public") === "1";
  const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID();
  const checkedAt = new Date().toISOString();
  const revision =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.OMNIAGENT_RELEASE_SHA ||
    undefined;
  const production =
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production";
  const dependencies = {
    databaseConfigured: hasDatabaseUrl(),
    openAiConfigured: hasOpenAIKey(),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
  };

  if (!hasDatabaseUrl()) {
    return Response.json(
      {
        status: production ? "unhealthy" : "degraded",
        checkedAt,
        requestId,
        revision,
        dependencies,
      },
      {
        status: production ? 503 : 200,
        headers: healthCacheHeaders(publicSummary),
      },
    );
  }

  try {
    await databaseReadinessCache.get("database", async () => {
      await ensureDatabaseSchema();
      await getSql()`SELECT 1 AS ok`;
      return true;
    });
    const ms = Date.now() - startedAt;
    const missingProductionDependency =
      production &&
      (!dependencies.openAiConfigured || !dependencies.cronSecretConfigured);
    if (missingProductionDependency) {
      return Response.json(
        {
          status: "unhealthy",
          checkedAt,
          requestId,
          revision,
          dependencies,
        },
        {
          status: 503,
          headers: healthCacheHeaders(publicSummary),
        },
      );
    }
    console.log(JSON.stringify({ level: "info", msg: "health ok", ms, route: "/api/health" }));
    return Response.json(
      { status: "healthy", checkedAt, requestId, revision, dependencies },
      {
        status: 200,
        headers: healthCacheHeaders(publicSummary),
      },
    );
  } catch (error) {
    const ms = Date.now() - startedAt;
    console.error(JSON.stringify({
      level: "error",
      msg: "health failed",
      ms,
      route: "/api/health",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { status: "unhealthy", checkedAt, requestId, revision, dependencies },
      {
        status: 503,
        headers: healthCacheHeaders(publicSummary),
      },
    );
  }
}

function healthCacheHeaders(publicSummary: boolean) {
  return {
    "cache-control": publicSummary
      ? "public, s-maxage=30, stale-while-revalidate=300"
      : "private, no-store",
  };
}
