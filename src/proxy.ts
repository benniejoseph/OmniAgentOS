import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const demoStorageFlag = "OMNIAGENT_ALLOW_DEMO_STORAGE";

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", contentSecurityPolicy);

  if (!shouldBlockWithoutDatabase()) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("content-security-policy", contentSecurityPolicy);
    return response;
  }

  const message = [
    "Production storage is not configured.",
    "Set DATABASE_URL for production, or set OMNIAGENT_ALLOW_DEMO_STORAGE=true only for an explicitly disposable demo deployment.",
  ].join(" ");

  if (request.nextUrl.pathname.startsWith("/api/")) {
    const response = NextResponse.json(
      {
        error: "Production database required",
        message,
        storageMode: "blocked",
      },
      { status: 503 },
    );
    response.headers.set("content-security-policy", contentSecurityPolicy);
    return response;
  }

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Production database required</title>
    <style nonce="${nonce}">
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0d1418; color: #f4f1ea; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      section { max-width: 680px; border: 1px solid rgba(244,241,234,.18); border-radius: 8px; padding: 28px; background: rgba(255,255,255,.04); }
      p { line-height: 1.6; color: rgba(244,241,234,.74); }
      code { color: #6ee7c8; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Production database required</h1>
        <p>${escapeHtml(message)}</p>
        <p>Autonomous execution requires durable Postgres storage for runs, approvals, workflow state, memory, and audit evidence.</p>
        <p>Set <code>DATABASE_URL</code> before serving this deployment.</p>
      </section>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": contentSecurityPolicy },
    },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

function shouldBlockWithoutDatabase() {
  return isProductionRuntime() &&
    !process.env.DATABASE_URL?.trim() &&
    process.env[demoStorageFlag] !== "true";
}

function isProductionRuntime() {
  return process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.OMNIAGENT_LOCAL_PRODUCTION !== "true");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildContentSecurityPolicy(nonce: string) {
  const production = process.env.NODE_ENV === "production";
  const secureDeployment = production && (Boolean(process.env.VERCEL) || process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://"));
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${production ? "" : " http: https: ws: wss:"}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secureDeployment ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
