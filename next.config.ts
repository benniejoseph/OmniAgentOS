import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";
const secureDeployment =
  production &&
  (Boolean(process.env.VERCEL) ||
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://"));
const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  outputFileTracingIncludes: {
    "/api/media/video/clip": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/agent": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/tools/*": ["node_modules/ffmpeg-static/ffmpeg"],
    "/api/workflows/*": ["node_modules/ffmpeg-static/ffmpeg"],
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
