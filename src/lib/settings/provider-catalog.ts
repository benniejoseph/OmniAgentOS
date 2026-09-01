import { createHash, createHmac } from "node:crypto";
import { CredentialVaultUnavailableError } from "@/lib/settings/credential-vault";
import {
  getProviderCredentials,
  saveModelCatalog,
  setProviderValidationState,
} from "@/lib/settings/store";
import type {
  ModelCatalogEntry,
  SettingsModelProvider,
} from "@/lib/settings/types";

type CatalogModel = Omit<
  ModelCatalogEntry,
  "id" | "tenantId" | "actorId" | "provider" | "discoveredAt" | "updatedAt"
>;

export class ProviderValidationError extends Error {
  constructor(
    readonly code:
      | "authentication_failed"
      | "rate_limited"
      | "provider_unavailable"
      | "request_rejected"
      | "catalog_unavailable",
    readonly status = 502,
  ) {
    super(providerValidationMessage(code));
    this.name = "ProviderValidationError";
  }
}

export function normalizeProviderCredentials(
  provider: SettingsModelProvider,
  value: unknown,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderValidationError("request_rejected", 400);
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  const specs = providerCredentialFields(provider);
  for (const field of specs) {
    const raw = source[field.name];
    if (raw === undefined || raw === null || raw === "") {
      if (field.required) throw new ProviderValidationError("request_rejected", 400);
      continue;
    }
    if (typeof raw !== "string") throw new ProviderValidationError("request_rejected", 400);
    const normalized = raw.trim();
    if (normalized.length < field.min || normalized.length > field.max) {
      throw new ProviderValidationError("request_rejected", 400);
    }
    result[field.name] = normalized;
  }
  return result;
}

export function providerCredentialFields(provider: SettingsModelProvider) {
  if (provider === "aws_bedrock") {
    return [
      { name: "accessKeyId", label: "Access key ID", required: true, min: 12, max: 256 },
      { name: "secretAccessKey", label: "Secret access key", required: true, min: 24, max: 512 },
      { name: "region", label: "AWS region", required: true, min: 3, max: 40 },
      { name: "sessionToken", label: "Session token", required: false, min: 16, max: 8_192 },
    ] as const;
  }
  return [
    { name: "apiKey", label: "API key", required: true, min: 16, max: 8_192 },
  ] as const;
}

export async function validateAndRefreshProvider(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
}) {
  await setProviderValidationState({ ...input, status: "validating" });
  try {
    const { connection, credentials } = await getProviderCredentials(input);
    const models = await discoverProviderModels(connection.provider, credentials);
    if (!models.length) throw new ProviderValidationError("catalog_unavailable");
    const savedModels = await saveModelCatalog({
      tenantId: input.tenantId,
      actorId: input.actorId,
      provider: connection.provider,
      models,
    });
    const refreshedAt = new Date().toISOString();
    const savedConnection = await setProviderValidationState({
      ...input,
      status: "connected",
      catalogRefreshedAt: refreshedAt,
    });
    return { connection: savedConnection, models: savedModels, refreshedAt };
  } catch (error) {
    if (error instanceof CredentialVaultUnavailableError) {
      await setProviderValidationState({
        ...input,
        status: "error",
        validationCode: "vault_unavailable",
      }).catch(() => undefined);
      throw error;
    }
    const normalized = normalizeProviderError(error);
    await setProviderValidationState({
      ...input,
      status: "error",
      validationCode: normalized.code,
    }).catch(() => undefined);
    throw normalized;
  }
}

async function discoverProviderModels(
  provider: SettingsModelProvider,
  credentials: Record<string, string>,
): Promise<CatalogModel[]> {
  if (provider === "openai") return discoverOpenAI(credentials.apiKey);
  if (provider === "google") return discoverGemini(credentials.apiKey);
  if (provider === "anthropic") return discoverAnthropic(credentials.apiKey);
  return discoverBedrock(credentials);
}

async function discoverOpenAI(apiKey: string): Promise<CatalogModel[]> {
  const body = await providerJson("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .map(recordValue)
    .filter((item) => typeof item.id === "string" && isUsefulOpenAIModel(item.id))
    .slice(0, 1_000)
    .map((item) => catalogModel(String(item.id), String(item.id), inferCapabilities(String(item.id)), String(item.description || "")));
}

async function discoverGemini(apiKey: string): Promise<CatalogModel[]> {
  const body = await providerJson(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    { headers: { "x-goog-api-key": apiKey } },
  );
  const data = Array.isArray(body.models) ? body.models : [];
  return data.map(recordValue).filter((item) => typeof item.name === "string").slice(0, 1_000).map((item) => {
    const modelId = String(item.name).replace(/^models\//, "");
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods.map(String)
      : [];
    const capabilities = methods.some((method) => method.includes("embed"))
      ? ["embeddings"]
      : inferCapabilities(modelId);
    return catalogModel(modelId, typeof item.displayName === "string" ? item.displayName : modelId, capabilities, String(item.description || ""));
  });
}

async function discoverAnthropic(apiKey: string): Promise<CatalogModel[]> {
  const body = await providerJson("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map(recordValue).filter((item) => typeof item.id === "string").slice(0, 1_000).map((item) => {
    const modelId = String(item.id);
    return catalogModel(
      modelId,
      typeof item.display_name === "string" ? item.display_name : modelId,
      inferCapabilities(modelId),
      String(item.description || ""),
    );
  });
}

async function discoverBedrock(credentials: Record<string, string>): Promise<CatalogModel[]> {
  const region = credentials.region;
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new ProviderValidationError("request_rejected", 400);
  }
  const url = new URL(`https://bedrock.${region}.amazonaws.com/foundation-models`);
  const headers = signedAwsHeaders({
    url,
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });
  const body = await providerJson(url.toString(), { headers });
  const data = Array.isArray(body.modelSummaries) ? body.modelSummaries : [];
  return data.map(recordValue).filter((item) => typeof item.modelId === "string").slice(0, 1_000).map((item) => {
    const modelId = String(item.modelId);
    const lifecycle = recordValue(item.modelLifecycle);
    const state = String(lifecycle.status || "").toUpperCase() === "LEGACY" ? "deprecated" : "unknown";
    return {
      ...catalogModel(modelId, typeof item.modelName === "string" ? item.modelName : modelId, inferCapabilities(modelId)),
      lifecycle: state,
      lifecycleReason: state === "deprecated" ? "AWS reports this foundation model as legacy." : undefined,
    };
  });
}

async function providerJson(url: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderValidationError("provider_unavailable");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderValidationError("authentication_failed", 401);
    }
    if (response.status === 429) throw new ProviderValidationError("rate_limited", 429);
    if (response.status >= 500) throw new ProviderValidationError("provider_unavailable");
    throw new ProviderValidationError("request_rejected", 400);
  }
  const body = await response.json().catch(() => undefined) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderValidationError("catalog_unavailable");
  }
  return body as Record<string, unknown>;
}

function signedAwsHeaders(input: {
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "bedrock";
  const payloadHash = sha256("");
  const baseHeaders: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) baseHeaders["x-amz-security-token"] = input.sessionToken;
  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${baseHeaders[name].trim()}\n`).join("");
  const canonicalRequest = [
    "GET",
    input.url.pathname,
    "",
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return {
    ...baseHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
  };
}

function catalogModel(modelId: string, displayName: string, capabilities: string[], providerDescription = ""): CatalogModel {
  const lifecycleHint = `${modelId} ${displayName} ${providerDescription}`.toLowerCase();
  const lifecycle = lifecycleHint.includes("deprecated") || lifecycleHint.includes("legacy")
    ? "deprecated"
    : lifecycleHint.includes("retiring") || lifecycleHint.includes("retirement") || lifecycleHint.includes("sunset")
      ? "retiring"
      : "unknown";
  return {
    modelId,
    displayName,
    capabilities,
    lifecycle,
    lifecycleReason: lifecycle === "unknown"
      ? "The provider did not publish a lifecycle state. Refresh before changing production routing."
      : "The provider catalog describes this model as deprecated or approaching retirement.",
    lifecycleCheckedAt: new Date().toISOString(),
  };
}

function inferCapabilities(modelId: string) {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("embed")) return ["embeddings"];
  if (normalized.includes("whisper") || normalized.includes("transcri")) return ["audio", "transcription"];
  if (normalized.includes("tts") || normalized.includes("speech")) return ["audio", "speech"];
  if (normalized.includes("image") || normalized.includes("dall-e")) return ["image"];
  return normalized.includes("vision") || normalized.includes("gemini") || normalized.includes("claude") || normalized.includes("gpt-4") || normalized.includes("gpt-5")
    ? ["text", "vision", "tools"]
    : ["text", "tools"];
}

function isUsefulOpenAIModel(modelId: string) {
  return /^(gpt-|o\d|text-embedding|whisper|tts-|dall-e|omni-|computer-use)/i.test(modelId);
}

function normalizeProviderError(error: unknown) {
  if (error instanceof ProviderValidationError) return error;
  return new ProviderValidationError("provider_unavailable");
}

function providerValidationMessage(code: ProviderValidationError["code"]) {
  if (code === "authentication_failed") return "The provider rejected these credentials.";
  if (code === "rate_limited") return "The provider rate limit prevented validation. Try again later.";
  if (code === "request_rejected") return "The provider configuration is incomplete or invalid.";
  if (code === "catalog_unavailable") return "The provider connected but did not return a usable model catalog.";
  return "The provider could not be reached for validation.";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}
