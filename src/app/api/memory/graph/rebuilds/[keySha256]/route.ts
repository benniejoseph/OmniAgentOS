import { withDatabaseRequestScope } from "@/lib/db/client";
import { readMemoryDeterministicNativeHttp } from "@/lib/memory/deterministic-native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, context: { params: Promise<{ keySha256: string }> }) =>
  readMemoryDeterministicNativeHttp(request, "graph", (await context.params).keySha256));
