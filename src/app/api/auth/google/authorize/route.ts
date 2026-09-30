import { createGooglePrivateAuthorization } from "@/lib/auth/google";
import { serverErrorResponse } from "@/lib/http/errors";
import { enforcePrivateNoStore } from "@/lib/http/response";

export const runtime = "nodejs";

export async function GET() {
  try {
    return enforcePrivateNoStore(
      Response.redirect(createGooglePrivateAuthorization(), 302),
    );
  } catch (error) {
    return serverErrorResponse(error, {
      message: "Google owner login failed.",
      status: 503,
    });
  }
}
