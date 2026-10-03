export type UniverseLayer = "evidence" | "verified";

export type UniverseSelectionRequest = Readonly<{
  mode: UniverseLayer;
  id: string;
  controller: AbortController;
}>;

/** A selection response is useful only for the exact request that is still open. */
export function createUniverseSelectionGuard() {
  let current: UniverseSelectionRequest | undefined;
  return {
    begin(mode: UniverseLayer, id: string) {
      current?.controller.abort();
      current = { mode, id, controller: new AbortController() };
      return current;
    },
    isCurrent(request: UniverseSelectionRequest) {
      return current === request && !request.controller.signal.aborted;
    },
    clear() {
      current?.controller.abort();
      current = undefined;
    },
  };
}

export function universeDetailForSelection(
  body: unknown,
  selection: Pick<UniverseSelectionRequest, "mode" | "id">,
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The selected point returned an invalid detail response.");
  }
  const record = body as Record<string, unknown>;
  const expectedVersion = selection.mode === "evidence"
    ? "memory-universe-node:1"
    : "memory-universe-entity:1";
  const detail = record[selection.mode === "evidence" ? "node" : "entity"];
  if (
    record.version !== expectedVersion || !detail ||
    typeof detail !== "object" || Array.isArray(detail) ||
    (detail as Record<string, unknown>).id !== selection.id
  ) {
    throw new Error("The returned details do not match the selected point. Try again.");
  }
  return detail;
}
