import { ZodError } from "zod";
import { NativeConnectorError } from "@/lib/connectors/native-control-contracts";
export const nativeConnectorHeaders = { "cache-control": "private, no-store" };
export function privateConnectorResponse(response: Response) { response.headers.set("cache-control", nativeConnectorHeaders["cache-control"]); return response; }
export function nativeConnectorFailureResponse(error: unknown) {
  return Response.json(error instanceof NativeConnectorError ? { error: error.message, code: error.code } : error instanceof ZodError
    ? { error: "Invalid connector action contract.", code: "connector_invalid" }
    : { error: "Connector action evidence is unavailable. Read the exact receipt before taking another action.", code: "connector_unconfirmed" },
  { status: error instanceof NativeConnectorError ? error.status : error instanceof ZodError ? 400 : 503, headers: nativeConnectorHeaders });
}
