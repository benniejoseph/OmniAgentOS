import { ZodError } from "zod";
import { SharedContextAuthorityError } from "@/lib/memory/shared-context";
import { CsmError } from "./contracts";

export const csmNoStoreHeaders = { "cache-control": "private, no-store" };

export function csmErrorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({ error: "Invalid client context request.", details: error.flatten() }, { status: 400, headers: csmNoStoreHeaders });
  if (error instanceof CsmError) return Response.json({ error: error.message }, { status: error.status, headers: csmNoStoreHeaders });
  if (error instanceof SharedContextAuthorityError) return Response.json({ error: "Client context access is unavailable." }, {
    status: error.code === "scope_not_found" ? 404 : 503, headers: csmNoStoreHeaders,
  });
  console.error("Client context operation failed.", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "Client context is temporarily unavailable. Your accepted edits can be retried with the same edit key." }, { status: 503, headers: csmNoStoreHeaders });
}
