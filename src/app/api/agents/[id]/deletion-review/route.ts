import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeAgentSkillReviewResponse } from "@/lib/skills/native-mutation-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string }> }) =>
  nativeAgentSkillReviewResponse(request, (await route.params).id, true));
