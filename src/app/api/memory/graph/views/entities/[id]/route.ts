import { readNativeMemoryGraphEntity } from "@/lib/app-services/memory-graph-reads";
import { nativeGraphReadHandler, privateGraphQuery } from "../../native-http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return nativeGraphReadHandler((caller, current) => { privateGraphQuery(current, []); return readNativeMemoryGraphEntity(caller, id); })(request);
}
