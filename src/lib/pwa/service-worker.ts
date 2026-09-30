import { createHash } from "node:crypto";

/** What the worker stores at install, so the offline page needs no network. */
const shell = ["/offline", "/asael-mark.png", "/manifest.webmanifest"];

export const serviceWorkerHeaders = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "no-cache, no-store, must-revalidate",
  "content-security-policy": "default-src 'self'; script-src 'self'",
} as const;

/**
 * Names the cache for this deployment. Each release serves a different worker,
 * so browsers install it and it deletes the previous release's cache.
 */
export function serviceWorkerCacheName(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const release =
    env.VERCEL_DEPLOYMENT_ID?.trim() ||
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    env.OMNIAGENT_RELEASE_SHA?.trim() ||
    "development";
  const digest = createHash("sha256").update(release).digest("hex");
  return `asael-shell-${digest.slice(0, 16)}`;
}

export function serviceWorkerScript(cacheName: string) {
  return `const CACHE = ${JSON.stringify(cacheName)};
const SHELL = ${JSON.stringify(shell)};

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  // The offline page's styles and scripts, which the previous release's
  // cache no longer holds once this worker activates.
  const page = await cache.match("/offline");
  const html = page ? await page.text() : "";
  const assets = new Set();
  for (const match of html.matchAll(/(?:href|src)="(\\/_next\\/static\\/[^"]+)"/g)) {
    assets.add(match[1].replaceAll("&amp;", "&"));
  }
  await Promise.all([...assets].map((asset) => cache.add(asset).catch(() => undefined)));
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline")));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/asael-mark.png") {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        // Copy before the page can read the body, which a copy then needs.
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    })));
  }
});
`;
}
