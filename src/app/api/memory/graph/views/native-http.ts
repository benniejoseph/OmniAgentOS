import { z } from "zod";
import { createAppServiceCaller, type AppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { NativePrivateActionError } from "@/lib/memory/private-action-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

const headers = { "cache-control": "private, no-store" };
export function privateGraphQuery(request: Request, allowed: readonly string[]): Record<string, unknown> {
  const entries = [...new URL(request.url).searchParams];
  if (entries.some(([key]) => !allowed.includes(key)) || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new NativePrivateActionError("memory_graph_query", 400, "The graph read requires exact, unrepeated query fields.");
  }
  const query: Record<string, unknown> = Object.fromEntries(entries);
  if (query.history !== undefined) {
    if (query.history !== "true" && query.history !== "false") throw new NativePrivateActionError("memory_graph_query", 400, "History must be true or false.");
    query.history = query.history === "true";
  }
  return query;
}
export function nativeGraphReadHandler(work: (caller: AppServiceCaller, request: Request) => Promise<{ data: Record<string, unknown>; receipt: unknown }>) {
  return withDatabaseRequestScope(async (request: Request) => {
    let context;
    try { context = await authorizeRequest({ request, action: "read", resourceType: "memory_graph" }); }
    catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", "private, no-store"); return response; }
    try {
      const result = await work(createAppServiceCaller({ context }), request);
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
    } catch (error) {
      if (error instanceof NativePrivateActionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
      if (error instanceof z.ZodError) return Response.json({ error: "The graph request or response is outside its supported contract." }, { status: 400, headers });
      return Response.json({ error: "The private graph could not be read." }, { status: 503, headers });
    }
  });
}
