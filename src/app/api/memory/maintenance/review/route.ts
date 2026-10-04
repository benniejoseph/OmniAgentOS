import { withDatabaseRequestScope } from "@/lib/db/client";
import { readMemoryDeterministicNativeHttp } from "@/lib/memory/deterministic-native-http";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope((request: Request) => readMemoryDeterministicNativeHttp(request, "maintenance"));
