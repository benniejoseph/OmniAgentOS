import { createHash } from "node:crypto";
import { projectWorkToolResult } from "@/lib/orchestration/work-result-projection";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Model context only. Full results remain in the governed execution receipt. */
export function projectToolResult(toolId: string, result: unknown): unknown {
  const work = projectWorkToolResult(toolId, result);
  if (work !== result) return work;
  const value = object(result);
  if (toolId !== "app.watches.show" || !value || !Array.isArray(value.checks)) return result;
  const checks = value.checks.slice(0, 2);
  const last = object(checks.at(-1));
  const watch = object(value.watch);
  return {
    ...value,
    checks,
    hasMore: value.hasMore === true || value.checks.length > checks.length,
    nextPage: value.checks.length > checks.length && last && watch
      ? { id: watch.id, limit: 2, before: { scheduledFor: last.scheduledFor, id: last.id } }
      : value.nextPage,
    projection: { kind: "watch_summary", includedChecks: checks.length,
      omittedChecks: value.checks.length - checks.length,
      historyTool: "app.watches.show", fullResultInExecutionReceipt: true },
  };
}

/** Keep JSON structural validity at every budget, including deeply nested output.
 * Each shortened value carries an explicit coverage marker; never splice JSON. */
export function serializeProjectedToolResult(payload: unknown, maxCharacters = 8_000): string {
  const envelope = (data: unknown) => ({ provenance: "tool_result", trust: "untrusted_data", data: data ?? null });
  const original = JSON.stringify(envelope(payload));
  if (original.length <= maxCharacters) return original;
  const originalSha256 = createHash("sha256").update(original).digest("hex");
  for (const limit of [2_000, 1_000, 500, 240, 100, 40]) {
    const omissions: string[] = [];
    const compact = (value: unknown, path: string, depth = 0): unknown => {
      if (typeof value === "string" && value.length > limit) {
        omissions.push(path);
        return value.slice(0, limit);
      }
      if (depth > 12) { omissions.push(path); return { omitted: true }; }
      if (Array.isArray(value)) {
        const count = limit >= 500 ? 4 : 1;
        if (value.length > count) omissions.push(`${path}[${count}:${value.length}]`);
        return value.slice(0, count).map((item, index) => compact(item, `${path}[${index}]`, depth + 1));
      }
      const record = object(value);
      if (!record) return value;
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, compact(item, `${path}.${key}`, depth + 1)]));
    };
    const data = compact(payload, "data");
    const output = JSON.stringify({ ...envelope(data), coverage: { truncated: true,
      originalSha256, originalCharacters: original.length, omittedPaths: omissions.slice(0, 40),
      omittedPathCount: omissions.length, fullResultInExecutionReceipt: true } });
    if (output.length <= maxCharacters) return output;
  }
  // Pathological schemas/field counts still get an honest, usable receipt pointer.
  const record = object(payload);
  const output = JSON.stringify({ ...envelope({ executionId: record?.executionId,
    status: record?.status, dryRun: record?.dryRun, result: { omitted: true } }),
    coverage: { truncated: true, originalSha256, originalCharacters: original.length,
      reason: "Result exceeds the model projection budget; no result fields were delivered.", fullResultInExecutionReceipt: true } });
  if (output.length <= maxCharacters) return output;
  return JSON.stringify({ truncated: true, data: null });
}
