import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  createRequestTelemetry,
  getObservabilityStats,
  listObservabilityEvents,
  recordRuntimeEvent,
  recordRuntimeEventSafely,
  type ObservabilityCategory,
  type ObservabilityLevel,
} from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const levels = ["info", "warn", "error"] as const;
const categories = ["api", "workflow", "alert", "diagnostics", "evaluation", "connector", "security", "system"] as const;

const markerSchema = z.object({
  action: z.enum(["record_marker"]),
  category: z.enum(categories).optional(),
  level: z.enum(levels).optional(),
  message: z.string().min(1).max(240).optional(),
  correlationId: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function GETHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "observability");
  const url = new URL(request.url);
  const level = normalizeLevel(url.searchParams.get("level"));
  const category = normalizeCategory(url.searchParams.get("category"));
  const correlationId =
    url.searchParams.get("correlationId")?.trim().slice(0, 200) || undefined;
  const route =
    url.searchParams.get("route")?.trim().slice(0, 500) || undefined;
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "observability",
      metadata: { level, category, correlationId, route, limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const [events, stats] = await Promise.all([
    listObservabilityEvents({ level, category, correlationId, route, limit, tenantId: context.tenantId }),
    getObservabilityStats({ tenantId: context.tenantId }),
  ]);

  await recordRuntimeEventSafely({
    category: "api",
    action: "observability.read",
    route: "/api/observability",
    method: "GET",
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    requestId: telemetry.requestId,
    correlationId: telemetry.correlationId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    resourceType: "observability",
    message: "Read observability timeline.",
    metadata: {
      count: events.length,
      filters: { level, category, correlationId, route, limit },
      ...telemetry.syntheticMetadata,
    },
  });

  return Response.json({ events, stats });
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "observability");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = markerSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid observability action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "observability",
      metadata: {
        action: parsed.data.action,
        category: parsed.data.category,
        level: parsed.data.level,
        hasMessage: Boolean(parsed.data.message),
        metadataKeys: Object.keys(parsed.data.metadata || {}).slice(0, 50),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const event = await recordRuntimeEvent({
    level: parsed.data.level || "info",
    category: parsed.data.category || "system",
    action: "observability.marker",
    route: "/api/observability",
    method: "POST",
    statusCode: 201,
    durationMs: Date.now() - startedAt,
    requestId: telemetry.requestId,
    correlationId: parsed.data.correlationId || telemetry.correlationId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    resourceType: "observability",
    message: parsed.data.message || "Operator observability marker.",
    metadata: {
      ...(parsed.data.metadata || {}),
      ...telemetry.syntheticMetadata,
    },
  });

  return Response.json({ event, stats: await getObservabilityStats({ tenantId: context.tenantId }) }, { status: 201 });
}

function normalizeLevel(value: string | null): ObservabilityLevel | "all" {
  return value === "info" || value === "warn" || value === "error" ? value : "all";
}

function normalizeCategory(value: string | null): ObservabilityCategory | "all" {
  return categories.includes(value as ObservabilityCategory) ? (value as ObservabilityCategory) : "all";
}
