export const MAX_CAPTURE_BATCH_FILES = 50;
export const MAX_CAPTURE_BATCH_FILE_BYTES = 5 * 1024 * 1024;
export const CAPTURE_BATCH_CONCURRENCY = 3;

export type CaptureBatchCandidate = Readonly<{
  name: string;
  size: number;
  type?: string;
  lastModified?: number;
}>;

export type CaptureBatchRejection = Readonly<{
  file: CaptureBatchCandidate;
  reason: "duplicate" | "empty" | "too_large" | "batch_full";
}>;

export function mergeCaptureBatchFiles<T extends CaptureBatchCandidate>(
  current: readonly T[],
  candidates: readonly T[],
) {
  const accepted: T[] = [];
  const rejected: CaptureBatchRejection[] = [];
  const known = new Set(current.map(captureBatchFileKey));

  for (const file of candidates) {
    const key = captureBatchFileKey(file);
    if (known.has(key)) {
      rejected.push({ file, reason: "duplicate" });
      continue;
    }
    if (file.size < 1) {
      rejected.push({ file, reason: "empty" });
      continue;
    }
    if (file.size > MAX_CAPTURE_BATCH_FILE_BYTES) {
      rejected.push({ file, reason: "too_large" });
      continue;
    }
    if (current.length + accepted.length >= MAX_CAPTURE_BATCH_FILES) {
      rejected.push({ file, reason: "batch_full" });
      continue;
    }
    known.add(key);
    accepted.push(file);
  }

  return { accepted, rejected };
}

export async function runCaptureBatch<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = CAPTURE_BATCH_CONCURRENCY,
) {
  const results = new Array<R>(items.length);
  const laneCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: laneCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

export function captureBatchFileKey(file: CaptureBatchCandidate) {
  return [
    file.name.trim().toLocaleLowerCase(),
    file.size,
    file.type || "",
    file.lastModified || 0,
  ].join("\u0000");
}

export function captureBatchTitle(filename: string) {
  return filename
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 240) || "Untitled capture";
}

export function captureSearchMatches(
  query: string,
  values: readonly (string | undefined)[],
) {
  const terms = captureSearchTerms(query);
  if (!terms.length) return true;
  const searchable = captureSearchTerms(values.filter(Boolean).join(" "));
  return terms.every((term) =>
    searchable.some((candidate) => candidate.includes(term))
  );
}

function captureSearchTerms(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function captureBatchRejectionMessage(
  rejected: readonly CaptureBatchRejection[],
) {
  if (!rejected.length) return undefined;
  const counts = rejected.reduce<Record<CaptureBatchRejection["reason"], number>>(
    (result, rejection) => {
      result[rejection.reason] += 1;
      return result;
    },
    { duplicate: 0, empty: 0, too_large: 0, batch_full: 0 },
  );
  const reasons = [
    counts.too_large ? `${counts.too_large} over 5 MB` : "",
    counts.empty ? `${counts.empty} empty` : "",
    counts.duplicate ? `${counts.duplicate} duplicate` : "",
    counts.batch_full ? `${counts.batch_full} beyond the 50-file batch limit` : "",
  ].filter(Boolean);
  return `${rejected.length} file${rejected.length === 1 ? " was" : "s were"} not added (${reasons.join(", ")}).`;
}
