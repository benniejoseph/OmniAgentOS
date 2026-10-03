export type VisualStudioResultIdentity = Readonly<{
  request: number;
  assetId: string;
}>;

export type VisualStudioRequestToken = Readonly<{
  request: number;
  kind: "create" | "save";
  result?: VisualStudioResultIdentity;
}>;

type MediaReceiptContext = { mode: "image" | "video" | "clip"; operation: "generate" | "edit" | "clip"; sourceAssetId: string };
export type VisualStudioAssetReceipt = {
  asset: { id: string; filename: string; byteCount: number; storageKind: string };
  model?: string;
  provider?: string;
};
export type VisualStudioIndexReceipt = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  lastError?: string;
};

/** Bind the route's receipt to its submitted operation without accepting a URL. */
export function readVisualStudioAssetReceipt(value: unknown, context: MediaReceiptContext): VisualStudioAssetReceipt | undefined {
  if (!isRecord(value) || !isRecord(value.asset) || value.operation !== context.operation) return undefined;
  const asset = value.asset;
  const kind = context.mode === "image" ? "image" : "video";
  const id = typeof asset.id === "string" ? asset.id.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)
    || typeof asset.filename !== "string" || !asset.filename.trim()
    || typeof asset.byteCount !== "number" || !Number.isSafeInteger(asset.byteCount) || asset.byteCount < 1 || asset.byteCount > 20 * 1024 * 1024
    || (asset.storageKind !== "database" && asset.storageKind !== "filesystem")
    || (value.kind !== undefined && value.kind !== kind)
    || (asset.mediaType !== undefined && (typeof asset.mediaType !== "string" || !asset.mediaType.startsWith(`${kind}/`)))) return undefined;
  if (context.mode !== "clip" && (typeof value.model !== "string" || !value.model.trim() || typeof value.provider !== "string" || !value.provider.trim())) return undefined;
  const expectedSources = context.sourceAssetId ? [context.sourceAssetId] : [];
  if (context.mode !== "clip" || value.sourceAssetIds !== undefined) {
    if (!Array.isArray(value.sourceAssetIds) || value.sourceAssetIds.length !== expectedSources.length || value.sourceAssetIds.some((id, index) => id !== expectedSources[index])) return undefined;
  }
  return {
    asset: { id, filename: asset.filename, byteCount: asset.byteCount, storageKind: asset.storageKind },
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
  };
}

export function readVisualStudioIndexReceipt(value: unknown, assetId: string): VisualStudioIndexReceipt | undefined {
  if (!isRecord(value) || !isRecord(value.asset) || value.asset.id !== assetId || !isRecord(value.job)) return undefined;
  const job = value.job;
  if (typeof job.id !== "string" || !job.id.trim() || typeof job.status !== "string" || !["queued", "running", "completed", "failed", "canceled"].includes(job.status)
    || (job.lastError !== undefined && typeof job.lastError !== "string")) return undefined;
  return {
    ...job,
    id: job.id,
    status: job.status as VisualStudioIndexReceipt["status"],
    ...(isRecord(job.progress) ? { progress: job.progress } : {}),
    ...(typeof job.lastError === "string" ? { lastError: job.lastError } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** A local receipt fence, not cancellation or authority for a server effect. */
export function createVisualStudioRequestGate() {
  let mounted = true;
  let sequence = 0;
  let pending: VisualStudioRequestToken | undefined;
  let result: VisualStudioResultIdentity | undefined;

  function isCurrent(token: VisualStudioRequestToken) {
    return mounted && pending === token;
  }

  function isCurrentResult(identity: VisualStudioResultIdentity) {
    return mounted && result === identity;
  }

  return {
    activate() {
      mounted = true;
    },
    dispose() {
      mounted = false;
      pending = undefined;
      result = undefined;
    },
    beginCreate(): VisualStudioRequestToken | undefined {
      if (!mounted || pending) return undefined;
      pending = Object.freeze({ request: ++sequence, kind: "create" });
      return pending;
    },
    beginSave(identity: VisualStudioResultIdentity): VisualStudioRequestToken | undefined {
      if (!isCurrentResult(identity) || pending) return undefined;
      pending = Object.freeze({ request: ++sequence, kind: "save", result: identity });
      return pending;
    },
    acceptResult(token: VisualStudioRequestToken, assetId: string) {
      if (!isCurrent(token) || token.kind !== "create") return undefined;
      result = Object.freeze({ request: token.request, assetId });
      return result;
    },
    canApplySave(token: VisualStudioRequestToken) {
      return isCurrent(token) && token.kind === "save" && Boolean(token.result && isCurrentResult(token.result));
    },
    isCurrent,
    isCurrentResult,
    finish(token: VisualStudioRequestToken) {
      if (!isCurrent(token)) return false;
      pending = undefined;
      return true;
    },
  };
}
