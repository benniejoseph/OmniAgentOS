import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeAgentSkillReceiptResponse } from "@/lib/skills/native-mutation-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ keySha256: string }> }) =>
  nativeAgentSkillReceiptResponse(request, (await route.params).keySha256, true));
