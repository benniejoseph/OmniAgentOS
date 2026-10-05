import { createHmac, hkdfSync } from "node:crypto";

/** Review evidence may describe an endpoint with a credential in its query.
 * Publish only an opaque tenant-keyed binding, never an offline guessing oracle. */
export function connectorNativePrivateDigest(tenantId: string, value: unknown) {
  let secret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL || process.env.VERCEL_ENV === "production") {
      throw new Error("The internal auth secret is required for private connector review bindings.");
    }
    secret = "asael-local-development-connector-review-key";
  }
  const key = Buffer.from(hkdfSync("sha256", secret, "", `asael:connector-native-review:v1\0${tenantId}`, 32));
  return createHmac("sha256", key).update(JSON.stringify(value), "utf8").digest("hex");
}

export function connectorNativePrivateFingerprint(tenantId: string, value: string) {
  return Buffer.from(connectorNativePrivateDigest(tenantId, ["contract-fingerprint:1", value]), "hex").toString("base64url");
}

export function connectorNativePublicEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  const endpointRedacted = Boolean(url.username || url.password || url.search || url.hash);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { endpoint: url.toString(), endpointRedacted };
}
