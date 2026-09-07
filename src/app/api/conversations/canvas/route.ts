import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  conversationCanvasServiceInputSchema,
  showConversationCanvasService,
} from "@/lib/app-services/conversation-canvas";
import { ConversationCanvasNotFoundError } from "@/lib/conversations/canvas-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const parsed = conversationCanvasServiceInputSchema.safeParse({
    threadId: url.searchParams.get("threadId") || undefined,
    threadLimit: numberQuery(url, "threadLimit", 24),
    runLimit: numberQuery(url, "runLimit", 120),
    artifactLimit: numberQuery(url, "artifactLimit", 80),
  });
  if (!parsed.success) return Response.json(
    { error: "Invalid Conversation canvas request.", details: parsed.error.flatten() },
    { status: 400, headers: privateNoStoreHeaders },
  );
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "conversation_canvas",
      resourceId: parsed.data.threadId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showConversationCanvasService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof ConversationCanvasNotFoundError) {
      return Response.json(
        { error: error.message },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    console.error(
      "Conversation canvas read failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "The Conversation canvas is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}

function numberQuery(url: URL, name: string, fallback: number) {
  const value = url.searchParams.get(name);
  return value === null || !value.trim() ? fallback : Number(value);
}
