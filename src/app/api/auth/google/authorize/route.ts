import { createGoogleOwnerAuthorization } from "@/lib/auth/google";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.redirect(createGoogleOwnerAuthorization(), 302);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Google owner login failed." },
      { status: 503 },
    );
  }
}
