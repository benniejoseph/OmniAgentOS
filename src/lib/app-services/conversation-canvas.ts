import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildConversationCanvasProjection } from "@/lib/conversations/canvas";
import { loadConversationCanvasSource } from "@/lib/conversations/canvas-store";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const conversationCanvasServiceInputSchema = z.object({
  threadId: z.string().trim().min(1).max(240).optional(),
  threadLimit: z.number().int().min(1).max(24).default(24),
  runLimit: z.number().int().min(1).max(200).default(120),
  artifactLimit: z.number().int().min(1).max(200).default(80),
}).strict();

type ConversationCanvasDependencies = Readonly<{
  loadSource: typeof loadConversationCanvasSource;
}>;

const defaultDependencies: ConversationCanvasDependencies = Object.freeze({
  loadSource: loadConversationCanvasSource,
});

export async function showConversationCanvasService(
  caller: AppServiceCaller,
  input: z.input<typeof conversationCanvasServiceInputSchema>,
  dependencies: ConversationCanvasDependencies = defaultDependencies,
) {
  const value = conversationCanvasServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.conversations.canvas.show"),
  );
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  return runWithDatabaseActorScope(
    caller.context.tenantId,
    requestActorBinding?.readableOwnerActorIds || [caller.context.actorId],
    async () => {
      const source = await dependencies.loadSource({
        tenantId: caller.context.tenantId,
        actorId: caller.context.actorId,
        requestActorBinding,
        ...value,
      });
      const projection = buildConversationCanvasProjection({ source });
      return completeAppServiceCall(authorized, { projection }, {
        resourceCount: projection.nodes.length,
      });
    },
  );
}

export type { ConversationCanvasDependencies };
