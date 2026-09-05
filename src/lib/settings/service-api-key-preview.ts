import { createHash } from "node:crypto";

const PREVIEW_TENANT_DIGEST_DOMAIN = "asael:service-api-key-preview:v2\0";

export function serviceApiKeyPreviewTenantSegmentV2(tenantId: string) {
  return createHash("sha256")
    .update(PREVIEW_TENANT_DIGEST_DOMAIN, "utf8")
    .update(tenantId, "utf8")
    .digest("base64url")
    .slice(0, 10);
}

export function serviceApiKeyPreviewMatches(
  preview: string,
  tenantId: string,
  keyId: string,
) {
  const tenantSegmentV2 = serviceApiKeyPreviewTenantSegmentV2(tenantId);
  const legacyTenantSegment = Buffer.from(tenantId, "utf8")
    .toString("base64url")
    .slice(0, 10);
  const suffix = keyId.slice(0, 8);
  return ["asael_sk", "omni_sk"].some((prefix) =>
    preview === `${prefix}_${tenantSegmentV2}…${suffix}` ||
    preview === `${prefix}_${legacyTenantSegment}…${suffix}`
  );
}
