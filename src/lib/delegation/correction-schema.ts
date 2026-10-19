type JsonObject = Record<string, unknown>;

export type CorrectionReceiptCatalog = Readonly<{
  citationIds: readonly string[];
  governedTools: readonly Readonly<{ toolId: string; executionId: string }>[];
}>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The correction requires an immutable object output schema.");
  }
  return value as JsonObject;
}

/** Narrow the immutable contract to IDs already admitted to this child run. */
export function structuredCorrectionSchema(value: unknown, receipts: CorrectionReceiptCatalog): JsonObject {
  const schema = object(value);
  const properties = object(schema.properties);
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error("The correction requires a closed immutable object output schema.");
  }
  const constrainIds = (value: unknown, ids: readonly string[]) => {
    const array = object(value);
    const items = object(array.items);
    if (array.type !== "array" || items.type !== "string") {
      throw new Error("The correction requires explicit receipt array contracts.");
    }
    const admitted = [...new Set(ids)].filter(id =>
      (!Array.isArray(items.enum) || items.enum.includes(id)) &&
      (typeof items.maxLength !== "number" || id.length <= items.maxLength));
    return admitted.length
      ? { ...array, items: { ...items, enum: admitted } }
      : { ...array, maxItems: 0 };
  };
  const toolIds = receipts.governedTools.map(receipt => receipt.executionId);
  const bind = (props: JsonObject) => ({ ...props,
    evidenceIds: constrainIds(props.evidenceIds, receipts.citationIds),
    toolExecutionIds: constrainIds(props.toolExecutionIds, toolIds),
  });
  const checks = object(properties.acceptanceChecks);
  const checkItems = object(checks.items);
  return { ...schema, required: Object.keys(properties), properties: {
    ...bind(properties),
    acceptanceChecks: { ...checks, items: { ...checkItems, properties: bind(object(checkItems.properties)) } },
  } };
}
