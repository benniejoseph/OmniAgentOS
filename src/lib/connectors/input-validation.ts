import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";

const MAX_CONNECTOR_SCHEMA_BYTES = 256_000;
const MAX_VALIDATOR_CACHE_ENTRIES = 500;
const unsupportedSchemaKeywords = new Set([
  "$dynamicRef",
  "$recursiveRef",
  "$ref",
  "contentEncoding",
  "contentMediaType",
  "pattern",
  "patternProperties",
]);
const validatorCache = new Map<string, ValidateFunction>();
const ajv = new Ajv({
  allErrors: false,
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  ownProperties: true,
  loopEnum: 100,
  loopRequired: 100,
});

export class ConnectorInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInputValidationError";
  }
}

export function validateConnectorInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
) {
  const executionSchema = {
    type: "object",
    ...schema,
    additionalProperties:
      schema.additionalProperties === undefined
        ? false
        : schema.additionalProperties,
  };
  assertSafeSchemaShape(executionSchema);
  let serialized: string;
  try {
    serialized = JSON.stringify(executionSchema);
  } catch {
    throw new ConnectorInputValidationError(
      "Connector input schema is not JSON serializable.",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONNECTOR_SCHEMA_BYTES) {
    throw new ConnectorInputValidationError(
      "Connector input schema exceeds the execution limit.",
    );
  }

  const key = createHash("sha256").update(serialized).digest("base64url");
  let validate = validatorCache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(executionSchema);
    } catch {
      throw new ConnectorInputValidationError(
        "Connector input schema is invalid or uses unsupported references.",
      );
    }
    if (validatorCache.size >= MAX_VALIDATOR_CACHE_ENTRIES) {
      validatorCache.clear();
    }
    validatorCache.set(key, validate);
  }

  if (!validate(input)) {
    const issue = validate.errors?.[0];
    const location = sanitizeDiagnostic(issue?.instancePath || "/");
    const message = sanitizeDiagnostic(issue?.message || "did not match the connector schema");
    throw new ConnectorInputValidationError(
      `Connector input ${location} ${message}.`,
    );
  }
}

function assertSafeSchemaShape(schema: unknown) {
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    nodes += 1;
    if (depth > 40 || nodes > 10_000) {
      throw new ConnectorInputValidationError(
        "Connector input schema is too deeply nested or complex.",
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (unsupportedSchemaKeywords.has(key)) {
        throw new ConnectorInputValidationError(
          `Connector input schema keyword ${key} is not supported safely.`,
        );
      }
      visit(item, depth + 1);
    }
  };
  visit(schema, 0);
}

function sanitizeDiagnostic(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
