import { readNativeMemoryGraphTemporal } from "@/lib/app-services/memory-graph-reads";
import { nativeGraphReadHandler, privateGraphQuery } from "../native-http";
export const runtime = "nodejs";
export const GET = nativeGraphReadHandler((caller, request) => readNativeMemoryGraphTemporal(caller,
  privateGraphQuery(request, ["entityId", "relationTypeId", "epistemicKind", "validAt", "recordedAt", "history", "limit"])));
