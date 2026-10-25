import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  JsonBodyError,
  parseJsonBody,
  readResponseBytesLimited,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { advanceStudioRun } from "./advance";
import { listStudioAssets, uploadStudioAsset } from "./assets";
import { studioOwner, verifyStudioAuthority } from "./authority";
import { studioIdSchema } from "./contracts";
import { resolveStudioCapabilities } from "./providers";
import {
  createStudioFlow,
  getStudioFlow,
  getStudioRun,
  listStudioFlows,
  listStudioRuns,
  providerContext,
  quoteStudioFlow,
  studioFlowAction,
  studioRunAction,
  submitStudioRun,
  updateStudioFlow,
} from "./service";
import { StudioError } from "./server-types";
import { withStudioTransaction } from "./store";

const privateHeaders = { "cache-control": "private, no-store" };
const flowActionSchema = z
  .object({
    action: z.enum(["duplicate", "archive"]),
    revision: z.number().int().positive(),
  })
  .strict();
const runActionSchema = z
  .object({ action: z.enum(["cancel", "retry-persistence", "advance"]) })
  .strict();
type RouteContext = { params: Promise<{ id?: string }> };
export type StudioRoute =
  | "capabilities"
  | "flows"
  | "flow"
  | "flow-actions"
  | "quote"
  | "runs"
  | "run"
  | "assets";

/** Shared authenticated envelope; provider handles and private attempt payloads never enter it. */
export function studioHandler(route: StudioRoute) {
  return withDatabaseRequestScope(
    async (request: Request, routeContext: RouteContext) => {
      let context: SecurityContext;
      try {
        context = await authorizeRequest({
          request,
          action: "run.agent",
          resourceType: "studio",
          metadata: { route },
        });
      } catch (error) {
        return forbiddenResponse(error);
      }
      try {
        const owner = studioOwner(context);
        const key = request.method === "GET" ? "" : idempotencyKey(request);
        const params = await routeContext.params;
        const id = ["flow", "flow-actions", "quote", "runs", "run"].includes(
          route,
        )
          ? studioIdSchema.parse(params.id)
          : "";
        let value: unknown;
        if (route === "capabilities") {
          await withStudioTransaction(owner, (tx) =>
            verifyStudioAuthority(tx, owner),
          );
          value = {
            capabilities: await resolveStudioCapabilities(
              providerContext(owner),
            ),
          };
        } else if (route === "flows") {
          value =
            request.method === "GET"
              ? { flows: await listStudioFlows(context) }
              : {
                  flow: await createStudioFlow(
                    context,
                    await parseJsonBody(request),
                    key,
                  ),
                };
        } else if (route === "flow") {
          value = {
            flow:
              request.method === "GET"
                ? await getStudioFlow(context, id)
                : await updateStudioFlow(
                    context,
                    id,
                    await parseJsonBody(request),
                    key,
                  ),
          };
        } else if (route === "flow-actions") {
          value = {
            flow: await studioFlowAction(
              context,
              id,
              flowActionSchema.parse(await parseJsonBody(request)),
              key,
            ),
          };
        } else if (route === "quote") {
          value = {
            quote: await quoteStudioFlow(
              context,
              id,
              await parseJsonBody(request),
              key,
            ),
          };
        } else if (route === "runs") {
          value =
            request.method === "GET"
              ? { runs: await listStudioRuns(context, id) }
              : {
                  run: await submitStudioRun(
                    context,
                    id,
                    await parseJsonBody(request),
                    key,
                  ),
                };
        } else if (route === "run") {
          if (request.method === "GET") {
            const cursor = z.coerce
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .parse(new URL(request.url).searchParams.get("afterSeq") ?? 0);
            value = await getStudioRun(context, id, cursor);
          } else {
            const { action } = runActionSchema.parse(
              await parseJsonBody(request),
            );
            value = {
              run:
                action === "advance"
                  ? await advanceStudioRun(context, id, request.signal)
                  : await studioRunAction(context, id, action),
            };
          }
        } else {
          await withStudioTransaction(owner, (tx) =>
            verifyStudioAuthority(tx, owner),
          );
          value =
            request.method === "GET"
              ? { assets: await listStudioAssets(context) }
              : {
                  asset: await uploadStudioAsset(
                    owner,
                    await uploadFile(request),
                    key,
                  ),
                };
        }
        return Response.json(value, { headers: privateHeaders });
      } catch (error) {
        if (error instanceof StudioError)
          return Response.json(
            {
              error: error.message,
              code: error.code,
              ...(error.issues ? { issues: error.issues } : {}),
            },
            { status: error.status, headers: privateHeaders },
          );
        if (error instanceof z.ZodError)
          return Response.json(
            {
              error: error.issues[0]
                ? `${error.issues[0].path.join(".") || "request"}: ${error.issues[0].message}`
                : "Invalid studio request.",
              code: "studio_invalid_request",
            },
            { status: 400, headers: privateHeaders },
          );
        if (error instanceof JsonBodyError)
          return Response.json(
            { error: error.message, code: "studio_invalid_body" },
            { status: error.status, headers: privateHeaders },
          );
        return Response.json(
          {
            error:
              "Studio could not complete this request. Your saved work remains available; try again.",
            code: "studio_unavailable",
          },
          { status: 503, headers: privateHeaders },
        );
      }
    },
  );
}
function idempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 180 || !/^[A-Za-z0-9:_./-]+$/.test(key))
    throw new StudioError(
      "A stable Idempotency-Key is required for studio changes.",
      400,
      "studio_request_key_required",
    );
  return key;
}
async function uploadFile(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
    throw new StudioError(
      "Upload one media file using multipart/form-data.",
      415,
    );
  const bounded = await readResponseBytesLimited(
    new Response(request.body, { headers: request.headers }),
    3 * 1024 * 1024 + 64 * 1024,
  );
  if (bounded.truncated)
    throw new StudioError(
      "Upload a media file of 3 MB or smaller.",
      413,
      "studio_upload_limit",
    );
  let form: FormData;
  try {
    form = await new Response(bounded.bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new StudioError("The media upload could not be read.");
  }
  const file = form.get("file");
  if (
    !(file instanceof File) ||
    form.getAll("file").length !== 1 ||
    [...form.keys()].some((k) => k !== "file")
  )
    throw new StudioError("Upload exactly one file.");
  return file;
}
