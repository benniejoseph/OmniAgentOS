import { readNativeMemoryGraphPaths } from "@/lib/app-services/memory-graph-reads";
import { nativeGraphReadHandler, privateGraphQuery } from "../native-http";
export const runtime = "nodejs";
export const GET = nativeGraphReadHandler((caller, request) => readNativeMemoryGraphPaths(caller, privateGraphQuery(request, ["q", "maxHops", "limit"])));
