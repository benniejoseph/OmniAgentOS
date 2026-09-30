import {
  serviceWorkerCacheName,
  serviceWorkerHeaders,
  serviceWorkerScript,
} from "@/lib/pwa/service-worker";

export function GET() {
  return new Response(serviceWorkerScript(serviceWorkerCacheName()), {
    headers: serviceWorkerHeaders,
  });
}
