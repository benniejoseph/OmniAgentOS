import "server-only";

import type {
  ModelTarget,
  ModelTextRequest,
  ProviderId,
} from "@/lib/models/types";

export type ModelRuntimeCredential =
  | Readonly<{
      kind: "api_key";
      apiKey: string;
    }>
  | Readonly<{
      kind: "aws_bedrock";
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      sessionToken?: string;
    }>;

export type ModelRuntimeContext = Readonly<{
  targets: readonly ModelTarget[];
  credentials: Readonly<Partial<Record<ProviderId, ModelRuntimeCredential>>>;
}>;

const requestContexts = new WeakMap<object, ModelRuntimeContext>();

/**
 * Attaches server-only routing material without adding enumerable request
 * fields. Model requests are often copied into receipts and diagnostics, so
 * credentials must never be part of their serializable shape.
 */
export function bindModelRuntime<TRequest extends ModelTextRequest>(
  request: TRequest,
  context: ModelRuntimeContext,
): TRequest {
  requestContexts.set(request, context);
  return request;
}

export function getModelRuntime(
  request: ModelTextRequest,
): ModelRuntimeContext | undefined {
  return requestContexts.get(request);
}

export function getModelRuntimeApiKey(
  request: ModelTextRequest,
  provider: ProviderId,
): string | undefined {
  const credential = requestContexts.get(request)?.credentials[provider];
  return credential?.kind === "api_key" ? credential.apiKey : undefined;
}

export function getModelRuntimeCredential(
  request: ModelTextRequest,
  provider: ProviderId,
): ModelRuntimeCredential | undefined {
  return requestContexts.get(request)?.credentials[provider];
}
