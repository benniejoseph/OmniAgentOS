import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";
const secureDeployment =
  production &&
  (Boolean(process.env.VERCEL) ||
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://"));
const WORKSPACE_PAGE_TRACE_EXCLUDES = [
  "node_modules/ffmpeg-static/ffmpeg",
  "node_modules/@napi-rs/canvas-*/**/*.node",
];
const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // Native binding pdf.js needs for DOMMatrix; left external so file tracing
  // ships the package and its platform binary with the document parser worker.
  serverExternalPackages: ["@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/media/video/clip": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/agent": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/tools/*": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/workflows/*": ["node_modules/ffmpeg-static/ffmpeg"],
  },
  // Workspace pages import the agent runner and the document parser, so their
  // traces pick up ffmpeg and the canvas binding although only route handlers
  // run them. Vercel ships every page in one function, and a cold dashboard
  // load paid for both binaries. Turbopack matches exclude keys anywhere in
  // the entry name, such as `/app/app/missions/page` or
  // `/app/api/capture/route`, so a bare `/app` key would strip the binaries
  // from every route handler too.
  outputFileTracingExcludes: {
    "/app/app/**": WORKSPACE_PAGE_TRACE_EXCLUDES,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
          },
          ...(secureDeployment
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
      {
        source: "/vendor/tradingview/charting_library/sameorigin.html",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
