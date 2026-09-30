import { describe, expect, it, vi } from "vitest";

import {
  serviceWorkerCacheName,
  serviceWorkerScript,
} from "@/lib/pwa/service-worker";

type Handler = (event: FakeEvent) => void;
type FakeEvent = {
  request?: Request;
  respondWith: (response: Promise<Response | undefined>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

const origin = "https://asael.example";

/** Browsers alone make navigation requests, so Request cannot construct one. */
function navigation(url: string) {
  return { method: "GET", mode: "navigate", url } as Request;
}

/** Runs the worker script against in-memory caches and a scripted network. */
function startWorker(options: {
  cacheName?: string;
  network: (request: Request) => Promise<Response>;
  existingCaches?: string[];
}) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  for (const name of options.existingCaches ?? []) stores.set(name, new Map());
  const later = () => new Promise((resolve) => setTimeout(resolve, 0));
  const cacheFor = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, entries);
    const key = (input: RequestInfo | URL) =>
      new URL(input instanceof Request ? input.url : String(input), origin).href;
    return {
      async add(input: string) {
        const response = await options.network(new Request(new URL(input, origin)));
        if (!response.ok) throw new TypeError(`${input} returned ${response.status}`);
        entries.set(key(input), response);
      },
      async addAll(inputs: string[]) {
        for (const input of inputs) await this.add(input);
      },
      async match(input: RequestInfo | URL) {
        return entries.get(key(input))?.clone();
      },
      async put(input: RequestInfo | URL, response: Response) {
        entries.set(key(input), response);
      },
    };
  };
  const caches = {
    // Opening a cache takes a turn of the event loop, as it does in browsers.
    async open(name: string) {
      await later();
      return cacheFor(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(input: RequestInfo | URL) {
      for (const name of stores.keys()) {
        const found = await cacheFor(name).match(input);
        if (found) return found;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const fetch = vi.fn((request: Request) => options.network(request));
  new Function("self", "caches", "fetch", serviceWorkerScript(options.cacheName ?? "asael-shell-current"))(
    self,
    caches,
    fetch,
  );

  const dispatch = async (type: string, request?: Request) => {
    let response: Promise<Response | undefined> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.get(type)?.({
      request,
      respondWith: (value) => { response = value; },
      waitUntil: (promise) => { pending.push(promise); },
    });
    return { response, settled: async () => { await Promise.all(pending); await Promise.all(pending); } };
  };
  const stored = (name: string, path: string) =>
    stores.get(name)?.get(new URL(path, origin).href)?.clone();
  return { dispatch, self, stores, stored, fetch };
}

const offlineHtml = [
  "<html><head>",
  '<link rel="stylesheet" href="/_next/static/css/app.css"/>',
  '<link rel="preload" href="/_next/static/media/font.woff2" as="font"/>',
  '<script src="/_next/static/chunks/main.js?v=1&amp;x=2" async=""></script>',
  '<script src="/_next/static/chunks/missing.js" async=""></script>',
  '<link rel="icon" href="/favicon.ico"/>',
  "</head><body>Offline</body></html>",
].join("");

function network(request: Request) {
  const { pathname, search } = new URL(request.url);
  if (pathname === "/offline") return Promise.resolve(new Response(offlineHtml));
  if (pathname.endsWith("missing.js")) return Promise.resolve(new Response("", { status: 404 }));
  return Promise.resolve(new Response(`body of ${pathname}${search}`));
}

describe("service worker cache name", () => {
  it("names a cache for each deployment without exposing the deployment", () => {
    const first = serviceWorkerCacheName({ VERCEL_DEPLOYMENT_ID: "dpl_first" });
    const second = serviceWorkerCacheName({ VERCEL_DEPLOYMENT_ID: "dpl_second" });

    expect(first).toMatch(/^asael-shell-[0-9a-f]{16}$/);
    expect(second).toMatch(/^asael-shell-[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("dpl_first");
  });

  it("falls back to the commit, then the release, when there is no deployment", () => {
    const named = serviceWorkerCacheName;

    expect(named({ VERCEL_DEPLOYMENT_ID: " ", VERCEL_GIT_COMMIT_SHA: "abc" }))
      .toBe(named({ VERCEL_DEPLOYMENT_ID: "abc" }));
    expect(named({ VERCEL_GIT_COMMIT_SHA: " ", OMNIAGENT_RELEASE_SHA: "def" }))
      .toBe(named({ VERCEL_DEPLOYMENT_ID: "def" }));
    expect(named({ VERCEL_GIT_COMMIT_SHA: "abc" })).not.toBe(named({ OMNIAGENT_RELEASE_SHA: "def" }));
    expect(named({})).toBe(named({ VERCEL_DEPLOYMENT_ID: "development" }));
  });
});

describe("service worker", () => {
  it("stores the offline page with its own styles and scripts at install", async () => {
    const worker = startWorker({ network });

    const install = await worker.dispatch("install");
    await install.settled();

    for (const path of [
      "/offline",
      "/asael-mark.png",
      "/manifest.webmanifest",
      "/_next/static/css/app.css",
      "/_next/static/media/font.woff2",
      "/_next/static/chunks/main.js?v=1&x=2",
    ]) {
      expect(worker.stored("asael-shell-current", path), path).toBeDefined();
    }
    // A missing asset does not stop the install, and nothing outside the
    // static assets is taken from the page.
    expect(worker.stored("asael-shell-current", "/_next/static/chunks/missing.js")).toBeUndefined();
    expect(worker.stored("asael-shell-current", "/favicon.ico")).toBeUndefined();
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("does not install when the offline page cannot be stored", async () => {
    const worker = startWorker({
      network: (request) =>
        new URL(request.url).pathname === "/offline"
          ? Promise.resolve(new Response("", { status: 503 }))
          : network(request),
    });

    const install = await worker.dispatch("install");

    await expect(install.settled()).rejects.toThrow("/offline returned 503");
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("deletes every other release's cache when it activates", async () => {
    const worker = startWorker({
      network,
      existingCaches: ["asael-shell-v2", "asael-shell-previous", "asael-shell-current"],
    });

    const activate = await worker.dispatch("activate");
    await activate.settled();

    expect([...worker.stores.keys()]).toEqual(["asael-shell-current"]);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();
  });

  it("stores a static asset the page has already read", async () => {
    const worker = startWorker({ network });
    const request = new Request(`${origin}/_next/static/chunks/page.js`);

    const fetched = await worker.dispatch("fetch", request);
    const response = await fetched.response;
    // The page reads the body before the cache opens.
    expect(await response?.text()).toBe("body of /_next/static/chunks/page.js");
    await fetched.settled();

    expect(await worker.stored("asael-shell-current", "/_next/static/chunks/page.js")?.text())
      .toBe("body of /_next/static/chunks/page.js");

    const again = await worker.dispatch("fetch", request);
    expect(await (await again.response)?.text()).toBe("body of /_next/static/chunks/page.js");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("does not store a failed static asset", async () => {
    const worker = startWorker({
      network: () => Promise.resolve(new Response("gone", { status: 404 })),
    });

    const fetched = await worker.dispatch("fetch", new Request(`${origin}/_next/static/chunks/old.js`));
    expect((await fetched.response)?.status).toBe(404);
    await fetched.settled();

    expect(worker.stored("asael-shell-current", "/_next/static/chunks/old.js")).toBeUndefined();
  });

  it("shows the stored offline page when a navigation fails", async () => {
    const worker = startWorker({ network });
    await (await worker.dispatch("install")).settled();
    worker.fetch.mockImplementation(() => Promise.reject(new TypeError("offline")));

    const failed = await worker.dispatch("fetch", navigation(`${origin}/app/capture`));

    expect(await (await failed.response)?.text()).toBe(offlineHtml);
  });

  it("leaves writes, other origins, and the API to the network", async () => {
    const worker = startWorker({ network });

    for (const request of [
      new Request(`${origin}/_next/static/chunks/page.js`, { method: "POST", body: "x" }),
      new Request("https://cdn.example/_next/static/chunks/page.js"),
      new Request(`${origin}/api/session`),
      navigation(`${origin}/api/session`),
      new Request(`${origin}/app/data.json`),
    ]) {
      expect((await worker.dispatch("fetch", request)).response, request.url).toBeUndefined();
    }
  });
});
