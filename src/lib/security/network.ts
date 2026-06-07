import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const blockedHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

export async function assertPublicHttpUrl(value: string, label = "URL") {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must use http or https.`);
  }

  if (url.username || url.password) {
    throw new Error(`${label} must not include embedded credentials.`);
  }

  if (url.protocol === "http:" && isHostedRuntime() && process.env.OMNIAGENT_CONNECTOR_ALLOW_HTTP !== "true") {
    throw new Error(`${label} must use https in hosted environments.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(hostname)) {
    throw new Error(`${label} points to a blocked internal hostname.`);
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error(`${label} points to a blocked private IP address.`);
    }
    return url.toString();
  }

  const resolved = await lookup(hostname, { all: true, verbatim: false });
  if (!resolved.length) {
    throw new Error(`${label} hostname did not resolve.`);
  }

  for (const address of resolved) {
    if (isPrivateIpAddress(address.address)) {
      throw new Error(`${label} resolves to a blocked private IP address.`);
    }
  }

  return url.toString();
}

export function isPrivateIpAddress(value: string) {
  if (value.includes(":")) {
    return isPrivateIpv6(value);
  }

  return isPrivateIpv4(value);
}

function isBlockedHostname(hostname: string) {
  return (
    blockedHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function isPrivateIpv4(value: string) {
  const octets = value.split(".").map((item) => Number(item));
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("::ffff:0:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function isHostedRuntime() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV === "production");
}
