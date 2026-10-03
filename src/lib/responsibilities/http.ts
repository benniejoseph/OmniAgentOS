import { JsonBodyError } from "@/lib/http/body";
import { forbiddenResponse } from "@/lib/security/guard";
import { ResponsibilityError } from "./state";
export const responsibilityHeaders = { "cache-control": "private, no-store" };
export function responsibilityDenial(error: unknown) {
  const response = forbiddenResponse(error); response.headers.set("cache-control", "private, no-store"); return response;
}
export function responsibilityFailure(error: unknown) {
  if (error instanceof ResponsibilityError) return Response.json({ error: error.message, code: error.code, ...(error.status === 409 ? { reload: true } : {}) }, { status: error.status, headers: responsibilityHeaders });
  if (error instanceof JsonBodyError) return Response.json({ error: error.message, code: "responsibility_request_invalid" }, { status: error.status, headers: responsibilityHeaders });
  return Response.json({ error: "Responsibility drafts are temporarily unavailable.", code: "responsibility_unavailable" }, { status: 503, headers: responsibilityHeaders });
}
export function exactQuery(request: Request, allowed: readonly string[]) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ResponsibilityError("The responsibility query is invalid.", 400, "responsibility_query_invalid");
  return params;
}
