import { createGooglePrivateAuthorization } from "@/lib/auth/google";
import { serverErrorResponse } from "@/lib/http/errors";
import { enforcePrivateNoStore } from "@/lib/http/response";
import { explicitCompanionReturn } from "@/lib/companion/return-path";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return enforcePrivateNoStore(
      Response.redirect(createGooglePrivateAuthorization(explicitCompanionReturn(new URL(request.url).search)), 302),
    );
  } catch (error) {
    return serverErrorResponse(error, {
      message: "Google owner login failed.",
      status: 503,
    });
  }
}
