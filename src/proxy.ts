import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const demoStorageFlag = "OMNIAGENT_ALLOW_DEMO_STORAGE";

export function proxy(request: NextRequest) {
  if (!shouldBlockWithoutDatabase()) {
    return NextResponse.next();
  }

  const message = [
    "Production storage is not configured.",
    "Set DATABASE_URL for production, or set OMNIAGENT_ALLOW_DEMO_STORAGE=true only for an explicitly disposable demo deployment.",
  ].join(" ");

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: "Production database required",
        message,
        storageMode: "blocked",
      },
      { status: 503 },
    );
  }

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Production database required</title>
    <style>
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
      headers: { "content-type": "text/html; charset=utf-8" },
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
