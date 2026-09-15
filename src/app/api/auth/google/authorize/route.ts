import { createGoogleOwnerAuthorization } from "@/lib/auth/google";
import { enforcePrivateNoStore } from "@/lib/http/response";

export const runtime = "nodejs";

export async function GET() {
  try {
    return enforcePrivateNoStore(
      Response.redirect(createGoogleOwnerAuthorization(), 302),
    );
  } catch (error) {
    return enforcePrivateNoStore(
      Response.json(
        { error: error instanceof Error ? error.message : "Google owner login failed." },
        { status: 503 },
      ),
    );
  }
}
