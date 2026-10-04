import { ZodError } from "zod";
import { SalesforceNativeError } from "@/lib/customer-success/salesforce-native-contracts";
export function salesforceNativeFailureResponse(error: unknown) {
  return Response.json(error instanceof SalesforceNativeError ? { error: error.message, code: error.code } : error instanceof ZodError
    ? { error: "Invalid Salesforce action contract.", code: "salesforce_action_invalid" }
    : { error: "Salesforce action evidence is unavailable. Read the exact receipt before taking another action.", code: "salesforce_action_unconfirmed" },
  { status: error instanceof SalesforceNativeError ? error.status : error instanceof ZodError ? 400 : 503, headers: { "cache-control": "private, no-store" } });
}
