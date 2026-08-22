import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

const blockedHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

const blockedAddresses = createBlockedAddressList();

const publicNetworkDispatcher = new Agent({
  connect: {
    lookup: publicAddressLookup,
  },
});

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

  if (url.protocol === "http:" && isProductionRuntime() && process.env.OMNIAGENT_CONNECTOR_ALLOW_HTTP !== "true") {
    throw new Error(`${label} must use https in production.`);
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error(`${label} points to a blocked internal hostname.`);
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error(`${label} points to a blocked private IP address.`);
    }
    return url.toString();
  }

  const resolved = await dnsLookup(hostname, { all: true, verbatim: false });
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

export async function fetchPublicHttpUrl(
  input: string | URL | Request,
  init: RequestInit = {},
  label = "URL",
) {
  const value = input instanceof Request ? input.url : input.toString();
  await assertPublicHttpUrl(value, label);
  if (init.redirect && init.redirect !== "manual") {
    throw new Error(`${label} redirects must be handled manually.`);
  }
  return fetch(input, {
    ...init,
    cache: init.cache || "no-store",
    redirect: "manual",
    // Node's fetch accepts an Undici dispatcher. The custom resolver below
    // validates the exact address used for each new socket, closing the DNS
    // rebinding gap between URL validation and connection establishment.
    dispatcher: publicNetworkDispatcher,
  } as RequestInit & { dispatcher: Agent });
}

export function isPrivateIpAddress(value: string) {
  const normalized = normalizeHostname(value);
  const family = isIP(normalized);
  if (!family) {
    return true;
  }
  return blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

function publicAddressLookup(
  hostname: Parameters<LookupFunction>[0],
  options: Parameters<LookupFunction>[1],
  callback: Parameters<LookupFunction>[2],
) {
  const normalizedHostname = normalizeHostname(hostname);
  if (isBlockedHostname(normalizedHostname)) {
    callback(networkLookupError("Hostname is blocked by outbound network policy."), "", 0);
    return;
  }

  if (isIP(normalizedHostname)) {
    if (isPrivateIpAddress(normalizedHostname)) {
      callback(networkLookupError("IP address is blocked by outbound network policy."), "", 0);
      return;
    }
    callback(null, normalizedHostname, isIP(normalizedHostname));
    return;
  }

  void dnsLookup(normalizedHostname, {
    all: true,
    verbatim: options.verbatim,
  }).then(
    (addresses) => {
      if (
        !addresses.length ||
        addresses.some((address) => isPrivateIpAddress(address.address))
      ) {
        callback(
          networkLookupError("Hostname resolved to a blocked or unavailable address."),
          "",
          0,
        );
        return;
      }

      const family = options.family === 4 || options.family === 6
        ? options.family
        : undefined;
      const candidates = family
        ? addresses.filter((address) => address.family === family)
        : addresses;
      if (!candidates.length) {
        callback(networkLookupError("Hostname has no address in the requested family."), "", 0);
        return;
      }
      if (options.all) {
        callback(null, candidates);
        return;
      }
      callback(null, candidates[0].address, candidates[0].family);
    },
    (error) => {
      callback(
        error instanceof Error
          ? Object.assign(error, { code: "EAI_FAIL" })
          : networkLookupError("Hostname lookup failed."),
        "",
        0,
      );
    },
  );
}

function networkLookupError(message: string) {
  return Object.assign(new Error(message), { code: "EACCES" });
}

function isBlockedHostname(hostname: string) {
  return (
    blockedHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function normalizeHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function createBlockedAddressList() {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV === "production",
  );
}
