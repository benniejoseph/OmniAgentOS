import { Ap2HumanPresentStoreError } from "@/lib/payments/ap2-store";

export const ap2PrivateHeaders = Object.freeze({
  "cache-control": "private, no-store",
});

export function ap2ErrorResponse(error: unknown) {
  if (error instanceof Ap2HumanPresentStoreError) {
    const status = error.code === "not_found"
      ? 404
      : error.code === "conflict"
        ? 409
        : error.code === "database_required" ||
            error.code === "adapter_required" ||
            error.code === "trust_policy_required"
          ? 503
          : 400;
    return Response.json(
      { error: error.code, message: error.message },
      { status, headers: ap2PrivateHeaders },
    );
  }
  return Response.json(
    {
      error: "ap2_request_failed",
      message: error instanceof Error ? error.message : "AP2 request failed.",
    },
    { status: 400, headers: ap2PrivateHeaders },
  );
}
