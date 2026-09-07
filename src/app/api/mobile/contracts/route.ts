import {
  nativeContractDiscovery,
  nativeContractSchemas,
} from "@/lib/mobile/contracts";

export const runtime = "nodejs";

export async function GET() {
  const discovery = nativeContractDiscovery();
  return Response.json(nativeContractSchemas.NativeContractDiscovery.parse(discovery), {
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
