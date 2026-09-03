import { z } from "zod";
import {
  createCaptureRecording,
  listCaptureRecordings,
} from "@/lib/capture/recordings";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseBoundedInteger, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const createRecordingSchema = z.object({
  title: z.string().trim().max(240).optional(),
  language: z.string().trim().max(35).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  metadata: z.record(z.string().max(80), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording" });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const limit = parseBoundedInteger(new URL(request.url).searchParams.get("limit"), 50, { max: 100 });
  return Response.json({
    recordings: await listCaptureRecordings(context, limit),
  }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_recording", metadata: { operation: "start" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.recording.start",
  );
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = createRecordingSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid recording details.", details: parsed.error.flatten() }, { status: 400 });
  const recording = await createCaptureRecording({
    ...context,
    ...parsed.data,
    executionScope,
  });
  return Response.json({ recording }, {
    status: 201,
    headers: { location: `/api/capture/recordings/${recording.id}`, "cache-control": "private, no-store" },
  });
}
