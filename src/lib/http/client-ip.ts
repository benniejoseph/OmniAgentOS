import { isIP } from "node:net";

export function getTrustedClientIp(request: Request) {
  const trustPlatformHeaders = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const trustConfiguredProxy = process.env.OMNIAGENT_TRUST_PROXY_HEADERS === "true";
  const forwarded = trustPlatformHeaders
    ? request.headers.get("x-vercel-forwarded-for")
    : trustConfiguredProxy
      ? request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip")
      : null;
  if (!forwarded) {
    return "unavailable";
  }
  const candidate = forwarded.split(",")[0]?.trim().toLowerCase() || "";
  return isIP(candidate) ? candidate : "unavailable";
}
