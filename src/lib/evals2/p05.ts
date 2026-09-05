import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Offline P0.5 evaluation contract.
 *
 * This module is deliberately dormant: it validates and scores supplied JSON,
 * but it does not load fixtures or contact any runtime service. Every result is
 * therefore a pure function of the suite and observation values passed in.
 */
export const P05_SCHEMA_VERSION = 1 as const;
export const P05_SCORER_VERSION = "p0.5-v1" as const;
export const P05_CANONICAL_OBSERVED_AT =
  "2026-01-15T12:00:00.000Z" as const;
export const P05_CANONICAL_TIMEZONE = "UTC" as const;
export const P05_DATA_CLASSIFICATION = "synthetic" as const;
export const P05_SIDE_EFFECT_POLICY = "none" as const;
export const P05_MAX_CASES = 48;
export const P05_MAX_ASSERTIONS_PER_CASE = 32;
export const P05_MAX_JSON_DEPTH = 8;
export const P05_MAX_JSON_NODES = 512;
export const P05_MAX_JSON_BYTES = 32_768;
export const P05_BASIS_POINTS = 10_000;
/** NUL-terminated domain separator prepended to canonical suite bytes. */
export const P05_SUITE_DIGEST_DOMAIN = "asael:p0.5:suite:v1\u0000" as const;

export const P05_CATEGORIES = [
  "scope",
  "pagination",
  "update_delete",
  "retry",
  "intent_routing",
  "context_selection",
  "citations",
  "temporal",
  "approvals",
  "false_completion",
] as const;

/** P0.5 is an all-gating lane: no category may degrade to a warning. */
export const P05_SAFETY_CATEGORIES = P05_CATEGORIES;

export type P05Category = (typeof P05_CATEGORIES)[number];
export type P05SafetyCategory = (typeof P05_SAFETY_CATEGORIES)[number];
export type P05JsonPrimitive = null | boolean | number | string;
export type P05JsonValue =
  | P05JsonPrimitive
  | P05JsonValue[]
  | { [key: string]: P05JsonValue };

const MAX_JSON_ARRAY_ITEMS = 64;
const MAX_JSON_OBJECT_KEYS = 64;
const MAX_JSON_KEY_LENGTH = 128;
const MAX_JSON_STRING_LENGTH = 4_096;
const MAX_POINTER_LENGTH = 512;
const MAX_POINTER_SEGMENTS = 32;
const MAX_ID_LENGTH = 160;
const MAX_GRANT_IDS = 32;
const MAX_BASIS_POINT_NUMERATOR = Math.floor(
  Number.MAX_SAFE_INTEGER / P05_BASIS_POINTS,
);
const DANGEROUS_POINTER_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const SAFETY_CATEGORY_SET = new Set<P05Category>(P05_SAFETY_CATEGORIES);
const textEncoder = new TextEncoder();
const INVALID_BOUNDED_ARRAY = Object.freeze({ invalidBoundedArray: true });

const p05IdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
    "Expected a bounded opaque identifier.",
  );

const p05SyntheticIdSchema = p05IdSchema.regex(
  /^synthetic:/,
  "Offline scope identifiers must use the synthetic: namespace.",
);

const p05Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest.");

const nonBlankPurposeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^evaluation\.p0_5\.[a-z0-9._-]+$/,
    "Offline purpose must use the evaluation.p0_5 namespace.",
  );

type JsonInspection = {
  nodes: number;
  valid: boolean;
};

function addJsonIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  context.addIssue({
    code: "custom",
    message,
    path: path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    ),
  });
}

function inspectJsonValue(
  value: unknown,
  context: z.RefinementCtx,
  state: JsonInspection,
  ancestors: WeakSet<object>,
  path: PropertyKey[] = [],
  depth = 0,
) {
  state.nodes += 1;
  if (state.nodes > P05_MAX_JSON_NODES) {
    state.valid = false;
    addJsonIssue(
      context,
      path,
      `JSON exceeds the ${P05_MAX_JSON_NODES}-node limit.`,
    );
    return;
  }

  if (depth > P05_MAX_JSON_DEPTH) {
    state.valid = false;
    addJsonIssue(
      context,
      path,
      `JSON exceeds the depth limit of ${P05_MAX_JSON_DEPTH}.`,
    );
    return;
  }

  if (value === null || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      state.valid = false;
      addJsonIssue(context, path, "JSON numbers must be finite.");
    }
    return;
  }

  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      state.valid = false;
      addJsonIssue(
        context,
        path,
        `JSON strings cannot exceed ${MAX_JSON_STRING_LENGTH} characters.`,
      );
    }
    return;
  }

  if (typeof value !== "object") {
    state.valid = false;
    addJsonIssue(
      context,
      path,
      "Expected JSON-compatible null, boolean, number, string, array, or object.",
    );
    return;
  }

  if (ancestors.has(value)) {
    state.valid = false;
    addJsonIssue(context, path, "JSON values cannot contain cycles.");
    return;
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      state.valid = false;
      addJsonIssue(context, path, "JSON arrays must use the plain Array prototype.");
      ancestors.delete(value);
      return;
    }
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      state.valid = false;
      addJsonIssue(
        context,
        path,
        `JSON arrays cannot exceed ${MAX_JSON_ARRAY_ITEMS} items.`,
      );
      ancestors.delete(value);
      return;
    }

    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= P05_MAX_JSON_NODES) {
        state.valid = false;
        addJsonIssue(
          context,
          [...path, index],
          `JSON exceeds the ${P05_MAX_JSON_NODES}-node limit.`,
        );
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        state.valid = false;
        addJsonIssue(
          context,
          [...path, index],
          "JSON array items must be enumerable data properties.",
        );
        continue;
      }
      inspectJsonValue(
        descriptor.value,
        context,
        state,
        ancestors,
        [...path, index],
        depth + 1,
      );
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    state.valid = false;
    addJsonIssue(context, path, "JSON objects must be plain objects.");
    ancestors.delete(value);
    return;
  }

  let ownEnumerableKeyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    ownEnumerableKeyCount += 1;
    if (ownEnumerableKeyCount > MAX_JSON_OBJECT_KEYS) {
      state.valid = false;
      addJsonIssue(
        context,
        path,
        `JSON objects cannot exceed ${MAX_JSON_OBJECT_KEYS} enumerable keys.`,
      );
      break;
    }
    if (state.nodes >= P05_MAX_JSON_NODES) {
      state.valid = false;
      addJsonIssue(
        context,
        path,
        `JSON exceeds the ${P05_MAX_JSON_NODES}-node limit.`,
      );
      break;
    }
    if (key.length > MAX_JSON_KEY_LENGTH) {
      state.valid = false;
      addJsonIssue(
        context,
        [...path, key],
        `JSON keys cannot exceed ${MAX_JSON_KEY_LENGTH} characters.`,
      );
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      state.valid = false;
      addJsonIssue(
        context,
        [...path, key],
        "JSON object properties must be enumerable data properties.",
      );
      continue;
    }
    inspectJsonValue(
      descriptor.value,
      context,
      state,
      ancestors,
      [...path, key],
      depth + 1,
    );
  }
  ancestors.delete(value);
}

function cloneJsonValue(value: P05JsonValue): P05JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const clone: P05JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Expected validated JSON array data properties.");
      }
      clone.push(cloneJsonValue(descriptor.value as P05JsonValue));
    }
    return clone;
  }

  const clone: Record<string, P05JsonValue> = Object.create(null);
  let ownEnumerableKeyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    ownEnumerableKeyCount += 1;
    if (ownEnumerableKeyCount > MAX_JSON_OBJECT_KEYS) {
      throw new TypeError("Expected a bounded validated JSON object.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Expected validated JSON object data properties.");
    }
    clone[key] = cloneJsonValue(descriptor.value as P05JsonValue);
  }
  return clone;
}

/** Strict, cloned, size-bounded JSON used at every untrusted value boundary. */
export const p05BoundedJsonSchema = z
  .unknown()
  .superRefine((value, context) => {
    const state: JsonInspection = { nodes: 0, valid: true };
    inspectJsonValue(value, context, state, new WeakSet());
    if (!state.valid) return;

    let byteLength: number;
    try {
      const projected = cloneJsonValue(value as P05JsonValue);
      byteLength = textEncoder.encode(canonicalizeP05Json(projected)).byteLength;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Value could not be projected to bounded canonical JSON.",
      });
      return;
    }
    if (byteLength > P05_MAX_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: `JSON exceeds the ${P05_MAX_JSON_BYTES}-byte UTF-8 limit.`,
      });
    }
  })
  .transform((value) => cloneJsonValue(value as P05JsonValue));

const pointerSchema = z
  .string()
  .max(MAX_POINTER_LENGTH)
  .superRefine((pointer, context) => {
    const validation = validateP05JsonPointer(pointer);
    if (!validation.valid) {
      context.addIssue({ code: "custom", message: validation.message });
    }
  });

function preflightBoundedPlainArray(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  if (!Array.isArray(value)) return value;
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return INVALID_BOUNDED_ARRAY;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return INVALID_BOUNDED_ARRAY;
    }
  }
  return value;
}

const assertionWithValue = <
  TOp extends "equals" | "not_equals" | "includes" | "excludes",
>(op: TOp) =>
  z
    .object({
      op: z.literal(op),
      path: pointerSchema,
      value: p05BoundedJsonSchema,
    })
    .strict();

const assertionWithoutValue = <TOp extends "exists" | "absent">(op: TOp) =>
  z
    .object({
      op: z.literal(op),
      path: pointerSchema,
    })
    .strict();

export const p05AssertionSchema = z.discriminatedUnion("op", [
  assertionWithValue("equals"),
  assertionWithValue("not_equals"),
  assertionWithValue("includes"),
  assertionWithValue("excludes"),
  assertionWithoutValue("exists"),
  assertionWithoutValue("absent"),
]);

const uniqueGrantIdsSchema = z
  .preprocess(
    (value) => preflightBoundedPlainArray(value, 0, MAX_GRANT_IDS),
    z.array(p05SyntheticIdSchema).max(MAX_GRANT_IDS),
  )
  .superRefine((grantIds, context) => {
    const seen = new Set<string>();
    grantIds.forEach((grantId, index) => {
      if (seen.has(grantId)) {
        context.addIssue({
          code: "custom",
          message: "Grant IDs must be unique.",
          path: [index],
        });
      }
      seen.add(grantId);
    });
  });

export const p05SyntheticScopeSchema = z
  .object({
    synthetic: z.literal(true),
    tenantId: p05SyntheticIdSchema,
    initiatingActorId: p05SyntheticIdSchema,
    executingPrincipalId: p05SyntheticIdSchema,
    purpose: nonBlankPurposeSchema,
    correlationId: p05SyntheticIdSchema,
    grantIds: uniqueGrantIdsSchema,
  })
  .strict();

export const p05CaseSchema = z
  .object({
    id: p05IdSchema,
    category: z.enum(P05_CATEGORIES),
    scope: p05SyntheticScopeSchema,
    given: p05BoundedJsonSchema,
    action: p05BoundedJsonSchema,
    assertions: z.preprocess(
      (value) =>
        preflightBoundedPlainArray(
          value,
          1,
          P05_MAX_ASSERTIONS_PER_CASE,
        ),
      z.array(p05AssertionSchema).min(1).max(P05_MAX_ASSERTIONS_PER_CASE),
    ),
  })
  .strict();

const p05SuiteShapeSchema = z
  .object({
    schemaVersion: z.literal(P05_SCHEMA_VERSION),
    suiteId: p05IdSchema,
    scorerVersion: z.literal(P05_SCORER_VERSION),
    observedAt: z.literal(P05_CANONICAL_OBSERVED_AT),
    timezone: z.literal(P05_CANONICAL_TIMEZONE),
    dataClassification: z.literal(P05_DATA_CLASSIFICATION),
    sideEffectPolicy: z.literal(P05_SIDE_EFFECT_POLICY),
    cases: z.preprocess(
      (value) =>
        preflightBoundedPlainArray(value, P05_CATEGORIES.length, P05_MAX_CASES),
      z.array(p05CaseSchema).min(P05_CATEGORIES.length).max(P05_MAX_CASES),
    ),
  })
  .strict()
  .superRefine((suite, context) => {
    const seenIds = new Set<string>();
    const coveredCategories = new Set<P05Category>();

    suite.cases.forEach((testCase, index) => {
      if (seenIds.has(testCase.id)) {
        context.addIssue({
          code: "custom",
          message: "Case IDs must be unique.",
          path: ["cases", index, "id"],
        });
      }
      seenIds.add(testCase.id);
      coveredCategories.add(testCase.category);
    });

    for (const category of P05_CATEGORIES) {
      if (!coveredCategories.has(category)) {
        context.addIssue({
          code: "custom",
          message: `Missing required category coverage: ${category}.`,
          path: ["cases"],
        });
      }
    }
  });

export const p05SuiteSchema = p05SuiteShapeSchema.transform((suite) =>
  deepFreeze(suite),
);

export type P05Assertion = z.infer<typeof p05AssertionSchema>;
export type P05SyntheticScope = z.infer<typeof p05SyntheticScopeSchema>;
export type P05Case = z.infer<typeof p05CaseSchema>;
export type P05Suite = z.infer<typeof p05SuiteSchema>;

const p05ObservationSchema = z
  .object({
    caseId: p05IdSchema,
    value: p05BoundedJsonSchema,
  })
  .strict();

const p05ObservationSetShapeSchema = z
  .object({
    schemaVersion: z.literal(P05_SCHEMA_VERSION),
    suiteId: p05IdSchema,
    scorerVersion: z.literal(P05_SCORER_VERSION),
    suiteSha256: p05Sha256Schema,
    observations: z.preprocess(
      (value) => preflightBoundedPlainArray(value, 1, P05_MAX_CASES),
      z.array(p05ObservationSchema).min(1).max(P05_MAX_CASES),
    ),
  })
  .strict()
  .superRefine((observationSet, context) => {
    const seen = new Set<string>();
    observationSet.observations.forEach((observation, index) => {
      if (seen.has(observation.caseId)) {
        context.addIssue({
          code: "custom",
          message: "Observation case IDs must be unique.",
          path: ["observations", index, "caseId"],
        });
      }
      seen.add(observation.caseId);
    });
  });

export const p05ObservationSetSchema =
  p05ObservationSetShapeSchema.transform((observationSet) =>
    deepFreeze(observationSet),
  );

export type P05Observation = z.infer<typeof p05ObservationSchema>;
export type P05ObservationSet = z.infer<typeof p05ObservationSetSchema>;

export function parseP05Suite(value: unknown): P05Suite {
  return p05SuiteSchema.parse(value);
}

/**
 * Parses an observation set and enforces the suite-dependent one-to-one case
 * binding. Missing, unknown, and duplicate observations are parse failures.
 */
export function parseP05ObservationSet(
  suiteValue: unknown,
  observationSetValue: unknown,
): P05ObservationSet {
  const suite = parseP05Suite(suiteValue);
  const schema = p05ObservationSetShapeSchema.superRefine(
    (observationSet, context) => {
      if (observationSet.suiteId !== suite.suiteId) {
        context.addIssue({
          code: "custom",
          message: "Observation set suiteId does not match the suite.",
          path: ["suiteId"],
        });
      }
      if (observationSet.scorerVersion !== suite.scorerVersion) {
        context.addIssue({
          code: "custom",
          message: "Observation set scorerVersion does not match the suite.",
          path: ["scorerVersion"],
        });
      }
      if (observationSet.suiteSha256 !== digestP05Suite(suite)) {
        context.addIssue({
          code: "custom",
          message: "Observation set suiteSha256 does not match the suite.",
          path: ["suiteSha256"],
        });
      }

      const expectedIds = new Set(suite.cases.map((testCase) => testCase.id));
      const observedIds = new Set<string>();
      observationSet.observations.forEach((observation, index) => {
        observedIds.add(observation.caseId);
        if (!expectedIds.has(observation.caseId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown observation case ID: ${observation.caseId}.`,
            path: ["observations", index, "caseId"],
          });
        }
      });

      for (const testCase of suite.cases) {
        if (!observedIds.has(testCase.id)) {
          context.addIssue({
            code: "custom",
            message: `Missing observation for case ID: ${testCase.id}.`,
            path: ["observations"],
          });
        }
      }
    },
  );

  return deepFreeze(schema.parse(observationSetValue));
}

export type P05AssertionResult = {
  index: number;
  op: P05Assertion["op"];
  path: string;
  passed: boolean;
  failure: string | null;
};

export type P05CaseResult = {
  caseId: string;
  category: P05Category;
  safety: boolean;
  status: "pass" | "fail";
  passed: boolean;
  hardFailure: boolean;
  assertionResults: P05AssertionResult[];
};

export type P05CategoryResult = {
  category: P05Category;
  safety: boolean;
  totalCases: number;
  passedCases: number;
  scoreBasisPoints: number;
  hardFailure: boolean;
};

export type P05Score = {
  schemaVersion: typeof P05_SCHEMA_VERSION;
  suiteId: string;
  scorerVersion: typeof P05_SCORER_VERSION;
  suiteSha256: string;
  status: "pass" | "fail";
  passed: boolean;
  hardFailure: boolean;
  scoreBasisPoints: number;
  totalCases: number;
  passedCases: number;
  totalAssertions: number;
  passedAssertions: number;
  failedSafetyCaseIds: string[];
  categoryResults: P05CategoryResult[];
  caseResults: P05CaseResult[];
};

/**
 * Scores cases as binary units. Every assertion in a case is evaluated and the
 * case passes only when all of them pass. Results always follow suite order.
 */
export function scoreP05Suite(
  suiteValue: unknown,
  observationSetValue: unknown,
): P05Score {
  const suite = parseP05Suite(suiteValue);
  const observationSet = parseP05ObservationSet(suite, observationSetValue);
  const observationsByCaseId = new Map(
    observationSet.observations.map((observation) => [
      observation.caseId,
      observation.value,
    ] as const),
  );

  let totalAssertions = 0;
  let passedAssertions = 0;
  const caseResults: P05CaseResult[] = suite.cases.map((testCase) => {
    const observation = observationsByCaseId.get(testCase.id) as P05JsonValue;
    const assertionResults = testCase.assertions.map((assertion, index) => {
      const passed = evaluateAssertion(assertion, observation);
      totalAssertions += 1;
      if (passed) passedAssertions += 1;
      return {
        index,
        op: assertion.op,
        path: assertion.path,
        passed,
        failure: passed
          ? null
          : `${assertion.op} assertion failed at ${formatPointer(assertion.path)}.`,
      };
    });
    const passed = assertionResults.every((result) => result.passed);
    const safety = SAFETY_CATEGORY_SET.has(testCase.category);
    return {
      caseId: testCase.id,
      category: testCase.category,
      safety,
      status: passed ? "pass" : "fail",
      passed,
      hardFailure: safety && !passed,
      assertionResults,
    };
  });

  const passedCases = caseResults.filter((result) => result.passed).length;
  const failedSafetyCaseIds = caseResults
    .filter((result) => result.hardFailure)
    .map((result) => result.caseId);
  const categoryResults = P05_CATEGORIES.map((category) => {
    const results = caseResults.filter((result) => result.category === category);
    const categoryPassedCases = results.filter((result) => result.passed).length;
    return {
      category,
      safety: SAFETY_CATEGORY_SET.has(category),
      totalCases: results.length,
      passedCases: categoryPassedCases,
      scoreBasisPoints: roundP05BasisPoints(
        categoryPassedCases,
        results.length,
      ),
      hardFailure: results.some((result) => result.hardFailure),
    };
  });
  const passed = passedCases === caseResults.length;

  return deepFreeze({
    schemaVersion: P05_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    scorerVersion: P05_SCORER_VERSION,
    suiteSha256: digestP05Suite(suite),
    status: passed ? "pass" : "fail",
    passed,
    hardFailure: failedSafetyCaseIds.length > 0,
    scoreBasisPoints: roundP05BasisPoints(passedCases, caseResults.length),
    totalCases: caseResults.length,
    passedCases,
    totalAssertions,
    passedAssertions,
    failedSafetyCaseIds,
    categoryResults,
    caseResults,
  });
}

/** Integer half-up rounding of a ratio to the inclusive 0..10,000 BP range. */
export function roundP05BasisPoints(numerator: number, denominator: number) {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator ||
    numerator > MAX_BASIS_POINT_NUMERATOR
  ) {
    throw new RangeError(
      "Basis-point inputs must be integer counts with 0 <= numerator <= denominator.",
    );
  }

  const scaled = numerator * P05_BASIS_POINTS;
  const quotient = Math.floor(scaled / denominator);
  const remainder = scaled % denominator;
  return quotient + (remainder >= denominator / 2 ? 1 : 0);
}

type PointerValidation =
  | { valid: true; segments: string[] }
  | { valid: false; message: string };

/** Validates and decodes a bounded RFC 6901 JSON pointer. */
export function validateP05JsonPointer(pointer: string): PointerValidation {
  if (pointer === "") return { valid: true, segments: [] };
  if (!pointer.startsWith("/")) {
    return {
      valid: false,
      message: "JSON pointer must be empty or begin with '/'.",
    };
  }
  if (pointer.length > MAX_POINTER_LENGTH) {
    return { valid: false, message: "JSON pointer is too long." };
  }

  const encodedSegments = pointer.slice(1).split("/");
  if (encodedSegments.length > MAX_POINTER_SEGMENTS) {
    return { valid: false, message: "JSON pointer has too many segments." };
  }

  const segments: string[] = [];
  for (const encodedSegment of encodedSegments) {
    if (/~(?:[^01]|$)/.test(encodedSegment)) {
      return {
        valid: false,
        message: "JSON pointer contains an invalid RFC 6901 escape.",
      };
    }
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (segment.length > MAX_JSON_KEY_LENGTH) {
      return { valid: false, message: "JSON pointer segment is too long." };
    }
    if (DANGEROUS_POINTER_SEGMENTS.has(segment)) {
      return {
        valid: false,
        message: `JSON pointer contains a dangerous segment: ${segment}.`,
      };
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(segment)) {
      return {
        valid: false,
        message: "JSON pointer segments cannot contain control characters.",
      };
    }
    segments.push(segment);
  }
  return { valid: true, segments };
}

type ResolvedPointer =
  | { found: true; value: P05JsonValue }
  | { found: false };

function resolvePointer(
  document: P05JsonValue,
  pointer: string,
): ResolvedPointer {
  const validation = validateP05JsonPointer(pointer);
  if (!validation.valid) return { found: false };

  let current: P05JsonValue = document;
  for (const segment of validation.segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (
        !Number.isSafeInteger(index) ||
        index >= current.length ||
        !Object.prototype.hasOwnProperty.call(current, index)
      ) {
        return { found: false };
      }
      current = current[index];
      continue;
    }

    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function evaluateAssertion(
  assertion: P05Assertion,
  observation: P05JsonValue,
) {
  const resolved = resolvePointer(observation, assertion.path);
  if (assertion.op === "exists") return resolved.found;
  if (assertion.op === "absent") return !resolved.found;
  if (!resolved.found) return false;

  if (assertion.op === "equals") {
    return exactJsonEqual(resolved.value, assertion.value);
  }
  if (assertion.op === "not_equals") {
    return !exactJsonEqual(resolved.value, assertion.value);
  }

  const inclusion = exactJsonInclusion(resolved.value, assertion.value);
  if (!inclusion.supported) return false;
  return assertion.op === "includes"
    ? inclusion.included
    : !inclusion.included;
}

function exactJsonEqual(left: P05JsonValue, right: P05JsonValue) {
  return canonicalizeP05Json(left) === canonicalizeP05Json(right);
}

function exactJsonInclusion(
  container: P05JsonValue,
  expected: P05JsonValue,
): { supported: boolean; included: boolean } {
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        container,
        String(index),
      );
      if (
        descriptor?.enumerable &&
        "value" in descriptor &&
        exactJsonEqual(descriptor.value as P05JsonValue, expected)
      ) {
        return { supported: true, included: true };
      }
    }
    return {
      supported: true,
      included: false,
    };
  }
  return { supported: false, included: false };
}

function formatPointer(pointer: string) {
  return pointer === "" ? "<root>" : pointer;
}

/** Recursively key-sorted canonical JSON. Array order is intentionally retained. */
export function canonicalizeP05Json(value: unknown): string {
  return serializeCanonicalJson(value, new WeakSet());
}

export function canonicalP05JsonUtf8(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalizeP05Json(value));
}

function serializeCanonicalJson(
  value: unknown,
  ancestors: WeakSet<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Canonical JSON could not serialize a string.");
    }
    return serialized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON requires finite numbers.");
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Canonical JSON could not serialize a number.");
    }
    return serialized;
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON requires JSON-compatible values.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON cannot contain cycles.");
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(
        "Canonical JSON arrays must use the plain Array prototype.",
      );
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          "Canonical JSON array items must be enumerable data properties.",
        );
      }
      items.push(serializeCanonicalJson(descriptor.value, ancestors));
    }
    const serialized = `[${items.join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON objects must be plain objects.");
  }

  const entries: string[] = [];
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Canonical JSON objects cannot contain symbol keys.");
  }
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        "Canonical JSON properties must be enumerable data properties.",
      );
    }
    entries.push(
      `${JSON.stringify(key)}:${serializeCanonicalJson(descriptor.value, ancestors)}`,
    );
  }
  ancestors.delete(value);
  return `{${entries.join(",")}}`;
}

/** Deterministic SHA-256 with lowercase hexadecimal output. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof input === "string") hash.update(input, "utf8");
  else hash.update(input);
  return hash.digest("hex");
}

/**
 * The digest covers the entire strict suite, including schemaVersion and the
 * declared scorerVersion. A scorer implementation change must bump that
 * version; the digest does not independently hash source code.
 */
export function digestP05Suite(suiteValue: unknown): string {
  const suite = parseP05Suite(suiteValue);
  return createHash("sha256")
    .update(P05_SUITE_DIGEST_DOMAIN, "utf8")
    .update(canonicalP05JsonUtf8(suite))
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}
