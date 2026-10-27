const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const size = (data: unknown) => JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data }).length;

/** The durable file receipt stays intact. This describes only the bytes delivered to the model. */
export function projectBuilderExecutionPayload(toolId: string, payload: Record<string, unknown>, maxCharacters: number): Record<string, unknown> | undefined {
  if (toolId !== "app.projects.builder.file.read" && toolId !== "app.projects.builder.framework-doc.read") return undefined;
  const result = object(payload.result), documentation = object(result?.documentation);
  const file = object(documentation?.file ?? result?.file), range = object(file?.lineRange);
  if (!result || !file || !range || typeof file.content !== "string" || typeof file.path !== "string" ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) || !Number.isSafeInteger(range.totalLines) ||
      Number(range.startLine) < 1 || Number(range.endLine) < Number(range.startLine)) return undefined;
  const start = Number(range.startLine), total = Number(range.totalLines);
  const lines = file.content.split("\n");
  if (lines.length !== Number(range.endLine) - start + 1) {
    const unavailable = { path: file.path, sha256: file.sha256, size: file.size, content: "",
      lineRange: { startLine: start, endLine: null, totalLines: total, truncated: true },
      projection: { kind: "builder_file_slice", limitation: "Source line coverage is unavailable after content transformation; no source lines were delivered." } };
    const unavailablePayload = { executionId: payload.executionId, status: payload.status, dryRun: payload.dryRun,
      result: documentation ? { documentation: { file: unavailable } } : { file: unavailable } };
    return size(unavailablePayload) <= maxCharacters ? unavailablePayload : { result: { omitted: true, limitation: "Source line coverage is unavailable." } };
  }
  if (size(payload) <= maxCharacters && range.characterLimitReached !== true) return payload;
  // A service-side character cutoff can end inside a line. Never advertise it as a complete line.
  const completeLines = range.characterLimitReached === true ? lines.slice(0, -1) : lines;
  const make = (count: number) => {
    const end = count ? start + count - 1 : null;
    const remaining = count < completeLines.length || range.characterLimitReached === true;
    const nextRead = count && (remaining || Number(end) < total)
      ? { path: file.path, startLine: Number(end) + 1, lineCount: Math.min(200, total - Number(end)) } : undefined;
    const projectedFile = { ...file, content: completeLines.slice(0, count).join("\n"),
      lineRange: { startLine: start, endLine: end, totalLines: total, truncated: true },
      projection: { kind: "builder_file_slice", originalRange: range,
        ...(count ? {} : { limitation: "The next complete source line exceeds the model result boundary; no source line was delivered." }),
        ...(nextRead ? { nextRead } : {}) } };
    const projectedResult = documentation
      ? { ...result, documentation: { ...documentation, file: projectedFile } }
      : { ...result, file: projectedFile };
    return { ...payload, result: projectedResult };
  };
  let low = 0, high = completeLines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(make(middle)) <= maxCharacters) low = middle;
    else high = middle - 1;
  }
  const projected = make(low);
  if (size(projected) <= maxCharacters) return projected;
  // Metadata itself does not fit. Omit the file instead of letting a generic clip contradict its range.
  return { executionId: payload.executionId, status: payload.status, dryRun: payload.dryRun,
    result: { omitted: true, limitation: "Builder read metadata exceeds the model result boundary; no source lines were delivered." } };
}
