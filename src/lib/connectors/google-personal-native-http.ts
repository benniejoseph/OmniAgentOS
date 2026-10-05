import { ZodError } from "zod";
import { GooglePersonalNativeError } from "@/lib/connectors/google-personal-native-contracts";
import { NativePrivateActionError } from "@/lib/memory/private-action-contracts";
export const googlePersonalNativeHeaders = { "cache-control": "private, no-store" };
export function googlePersonalPrivateResponse(response: Response) { response.headers.set("cache-control",googlePersonalNativeHeaders["cache-control"]); return response; }
export function googlePersonalNativeFailure(error: unknown) {
  const known = error instanceof GooglePersonalNativeError || error instanceof NativePrivateActionError;
  return Response.json(known ? { error: error.message,code: error.code } : error instanceof ZodError ? { error: "Invalid reviewed Google action.",code: "google_personal_invalid" }
    : { error: "Google action evidence is unavailable. Read the exact request before another action.",code: "google_personal_unconfirmed" },
    { status: known ? error.status : error instanceof ZodError ? 400 : 503,headers: googlePersonalNativeHeaders });
}
