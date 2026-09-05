import { describe, expect, it } from "vitest";
import p05SuiteFixture from "../../../evals/p05/suite.v1.json";
import {
  P05_CANONICAL_OBSERVED_AT,
  P05_CANONICAL_TIMEZONE,
  P05_CATEGORIES,
  P05_DATA_CLASSIFICATION,
  P05_SCHEMA_VERSION,
  P05_SCORER_VERSION,
  P05_SIDE_EFFECT_POLICY,
  P05_SUITE_DIGEST_DOMAIN,
  canonicalP05JsonUtf8,
  canonicalizeP05Json,
  digestP05Suite,
  p05AssertionSchema,
  p05BoundedJsonSchema,
  p05SuiteSchema,
  parseP05ObservationSet,
  parseP05Suite,
  roundP05BasisPoints,
  scoreP05Suite,
  sha256Hex,
  type P05Assertion,
  validateP05JsonPointer,
} from "@/lib/evals2/p05";

function makeCase(category: (typeof P05_CATEGORIES)[number], index: number) {
  return {
    id: `p05-${category}-${index}`,
    category,
    scope: {
      synthetic: true,
      tenantId: `synthetic:tenant:${index}`,
      initiatingActorId: `synthetic:actor:${index}`,
      executingPrincipalId: `synthetic:principal:${index}`,
      purpose: `evaluation.p0_5.${category}`,
      correlationId: `synthetic:correlation:${index}`,
      grantIds: [`synthetic:grant:${index}`],
    },
    given: { fixture: category, sequence: index },
    action: { kind: "observe", category },
    assertions: [
      { op: "equals", path: "/ok", value: true },
    ] as P05Assertion[],
  };
}

function validSuite() {
  return {
    schemaVersion: P05_SCHEMA_VERSION,
    suiteId: "asael-offline-p05-v1",
    scorerVersion: P05_SCORER_VERSION,
    observedAt: P05_CANONICAL_OBSERVED_AT,
    timezone: P05_CANONICAL_TIMEZONE,
    dataClassification: P05_DATA_CLASSIFICATION,
    sideEffectPolicy: P05_SIDE_EFFECT_POLICY,
    cases: P05_CATEGORIES.map(makeCase),
  };
}

function observationsFor(
  suite: ReturnType<typeof validSuite>,
  valueForCase: (testCase: ReturnType<typeof makeCase>) => unknown = () => ({
    ok: true,
  }),
) {
  return {
    schemaVersion: P05_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    scorerVersion: P05_SCORER_VERSION,
    suiteSha256: digestP05Suite(suite),
    observations: suite.cases.map((testCase) => ({
      caseId: testCase.id,
      value: valueForCase(testCase),
    })),
  };
}

describe("P0.5 suite contract", () => {
  it("accepts a strict, frozen suite covering all ten categories", () => {
    const parsed = parseP05Suite(validSuite());

    expect(parsed.cases).toHaveLength(10);
    expect(parsed.cases.map((testCase) => testCase.category)).toEqual(
      P05_CATEGORIES,
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.cases)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].scope)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].scope.grantIds)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].given)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].action)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].assertions)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0].assertions[0])).toBe(true);
  });

  it("parses the checked-in offline suite fixture through this contract", () => {
    const parsed = parseP05Suite(p05SuiteFixture);

    expect(parsed.suiteId).toBe("asael-p0.5-core-v1");
    expect(new Set(parsed.cases.map((testCase) => testCase.category))).toEqual(
      new Set(P05_CATEGORIES),
    );
  });

  it("rejects non-canonical metadata, missing scope, and unknown fields", () => {
    const suite = validSuite();
    expect(
      p05SuiteSchema.safeParse({ ...suite, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      p05SuiteSchema.safeParse({ ...suite, scorerVersion: "p0.5-v2" }).success,
    ).toBe(false);
    expect(
      p05SuiteSchema.safeParse({
        ...suite,
        observedAt: "2026-01-15T12:00:01.000Z",
      }).success,
    ).toBe(false);
    expect(
      p05SuiteSchema.safeParse({ ...suite, timezone: "Asia/Kolkata" }).success,
    ).toBe(false);
    expect(
      p05SuiteSchema.safeParse({ ...suite, dataClassification: "production" })
        .success,
    ).toBe(false);
    expect(
      p05SuiteSchema.safeParse({ ...suite, sideEffectPolicy: "allowed" })
        .success,
    ).toBe(false);
    expect(p05SuiteSchema.safeParse({ ...suite, extra: true }).success).toBe(
      false,
    );

    const missingScope = validSuite();
    const { executingPrincipalId: _removed, ...incompleteScope } =
      missingScope.cases[0].scope;
    missingScope.cases[0] = {
      ...missingScope.cases[0],
      scope: incompleteScope as typeof missingScope.cases[0]["scope"],
    };
    expect(p05SuiteSchema.safeParse(missingScope).success).toBe(false);

    const productionLikeScope = validSuite();
    productionLikeScope.cases[0].scope.tenantId = "tenant-production";
    expect(p05SuiteSchema.safeParse(productionLikeScope).success).toBe(false);
  });

  it("rejects duplicate case and grant IDs, missing coverage, and over 48 cases", () => {
    const duplicateCase = validSuite();
    duplicateCase.cases[1].id = duplicateCase.cases[0].id;
    expect(p05SuiteSchema.safeParse(duplicateCase).success).toBe(false);

    const duplicateGrant = validSuite();
    duplicateGrant.cases[0].scope.grantIds = [
      "synthetic:grant:duplicate",
      "synthetic:grant:duplicate",
    ];
    expect(p05SuiteSchema.safeParse(duplicateGrant).success).toBe(false);

    const missingCoverage = validSuite();
    missingCoverage.cases[7].category = "retry";
    expect(p05SuiteSchema.safeParse(missingCoverage).success).toBe(false);

    const tooMany = validSuite();
    for (let index = 10; index < 49; index += 1) {
      tooMany.cases.push(makeCase("retry", index));
    }
    expect(p05SuiteSchema.safeParse(tooMany).success).toBe(false);

    const oversizedSparseCases = validSuite();
    oversizedSparseCases.cases.length = 1_000_000;
    expect(p05SuiteSchema.safeParse(oversizedSparseCases).success).toBe(false);
  });

  it("rejects non-JSON and unbounded given/action values", () => {
    expect(p05BoundedJsonSchema.safeParse({ missing: undefined }).success).toBe(
      false,
    );
    expect(p05BoundedJsonSchema.safeParse({ invalid: Number.NaN }).success).toBe(
      false,
    );
    expect(p05BoundedJsonSchema.safeParse(new Date(0)).success).toBe(false);
    expect(p05BoundedJsonSchema.safeParse("x".repeat(4_097)).success).toBe(
      false,
    );
    expect(
      p05BoundedJsonSchema.safeParse(
        Array.from({ length: 10 }, () => "é".repeat(4_000)),
      ).success,
    ).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(p05BoundedJsonSchema.safeParse(cyclic).success).toBe(false);

    const oversizedSparse: unknown[] = [];
    oversizedSparse.length = 1_000_000;
    expect(p05BoundedJsonSchema.safeParse(oversizedSparse).success).toBe(false);

    let getterCalls = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "not-json-data";
      },
    });
    accessorArray.length = 1;
    expect(p05BoundedJsonSchema.safeParse(accessorArray).success).toBe(false);
    expect(getterCalls).toBe(0);

    class ArraySubclass extends Array<unknown> {}
    expect(p05BoundedJsonSchema.safeParse(new ArraySubclass()).success).toBe(
      false,
    );

    const hidden = { visible: true } as Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, "hidden", { value: "discarded" });
    hidden[Symbol("discarded")] = "discarded";
    const hiddenResult = p05BoundedJsonSchema.safeParse(hidden);
    expect(hiddenResult.success).toBe(true);
    if (hiddenResult.success) {
      expect(hiddenResult.data).toEqual({ visible: true });
      expect(Reflect.ownKeys(hiddenResult.data as object)).toEqual(["visible"]);
    }
  });

  it("uses strict discriminated assertion shapes", () => {
    expect(
      p05AssertionSchema.safeParse({
        op: "equals",
        path: "/ok",
        value: true,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      p05AssertionSchema.safeParse({ op: "equals", path: "/ok" }).success,
    ).toBe(false);
    expect(
      p05AssertionSchema.safeParse({
        op: "exists",
        path: "/ok",
        value: true,
      }).success,
    ).toBe(false);
  });

  it("accepts RFC 6901 escapes and rejects malformed or dangerous pointers", () => {
    expect(validateP05JsonPointer("")).toEqual({ valid: true, segments: [] });
    expect(validateP05JsonPointer("/a~1b/~0key")).toEqual({
      valid: true,
      segments: ["a/b", "~key"],
    });
    expect(validateP05JsonPointer("not-a-pointer").valid).toBe(false);
    expect(validateP05JsonPointer("/bad~2escape").valid).toBe(false);
    expect(validateP05JsonPointer("/__proto__/polluted").valid).toBe(false);
    expect(validateP05JsonPointer("/constructor").valid).toBe(false);

    const unsafeSuite = validSuite();
    unsafeSuite.cases[0].assertions = [
      { op: "equals", path: "/__proto__/polluted", value: true },
    ];
    expect(p05SuiteSchema.safeParse(unsafeSuite).success).toBe(false);
  });
});

describe("P0.5 observation binding", () => {
  it("requires exactly one observation for every suite case", () => {
    const suite = validSuite();
    const complete = observationsFor(suite);
    const parsed = parseP05ObservationSet(suite, complete);
    expect(parsed.observations).toHaveLength(10);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.observations)).toBe(true);
    expect(Object.isFrozen(parsed.observations[0].value)).toBe(true);

    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        observations: complete.observations.slice(1),
      }),
    ).toThrow(/Missing observation/);

    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        observations: [
          ...complete.observations.slice(0, -1),
          { caseId: "unknown-case", value: { ok: true } },
        ],
      }),
    ).toThrow(/Unknown observation/);

    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        observations: [
          ...complete.observations.slice(0, -1),
          complete.observations[0],
        ],
      }),
    ).toThrow(/unique/);
  });

  it("rejects observation envelope mismatches and unknown fields", () => {
    const suite = validSuite();
    const complete = observationsFor(suite);
    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        suiteId: "different-suite",
      }),
    ).toThrow(/suiteId/);
    expect(() =>
      parseP05ObservationSet(suite, { ...complete, extra: true }),
    ).toThrow();
    expect(() =>
      parseP05ObservationSet(suite, { ...complete, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        scorerVersion: "p0.5-v2",
      }),
    ).toThrow();
    expect(() =>
      parseP05ObservationSet(suite, {
        ...complete,
        suiteSha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).toThrow(/suiteSha256/);

    const stale = observationsFor(suite);
    suite.cases[0].action = { kind: "changed-after-observation" };
    expect(() => parseP05ObservationSet(suite, stale)).toThrow(/suiteSha256/);
  });
});

describe("P0.5 structural scorer", () => {
  it("evaluates all six exact operators and escaped pointers", () => {
    const suite = validSuite();
    suite.cases[0].assertions = [
      { op: "equals", path: "/object", value: { a: 1, b: 2 } },
      { op: "not_equals", path: "/state", value: "failed" },
      { op: "includes", path: "/items", value: { id: "citation-1" } },
      { op: "excludes", path: "/items", value: { id: "citation-2" } },
      { op: "exists", path: "/presentNull" },
      { op: "absent", path: "/missing" },
      { op: "equals", path: "/escaped/a~1b/~0key", value: "found" },
    ];
    const observationSet = observationsFor(suite, (testCase) =>
      testCase.id === suite.cases[0].id
        ? {
            ok: true,
            object: { b: 2, a: 1 },
            state: "completed",
            items: [{ id: "citation-1" }],
            presentNull: null,
            escaped: { "a/b": { "~key": "found" } },
          }
        : { ok: true },
    );

    const score = scoreP05Suite(suite, observationSet);
    expect(score.passed).toBe(true);
    expect(score.scoreBasisPoints).toBe(10_000);
    expect(score.caseResults[0].assertionResults.every((result) => result.passed)).toBe(
      true,
    );
  });

  it("limits includes and excludes to exact array membership", () => {
    const suite = validSuite();
    suite.cases[0].assertions = [
      { op: "includes", path: "/text", value: "needle" },
    ];
    const observationSet = observationsFor(suite, (testCase) =>
      testCase.id === suite.cases[0].id
        ? { text: "contains needle as a substring" }
        : { ok: true },
    );

    expect(scoreP05Suite(suite, observationSet)).toMatchObject({
      passed: false,
      hardFailure: true,
    });
  });

  it("ANDs assertions into binary cases and keeps suite result order", () => {
    const suite = validSuite();
    suite.cases[1].assertions = [
      { op: "equals", path: "/ok", value: true },
      { op: "equals", path: "/count", value: 2 },
    ];
    const observationSet = observationsFor(suite, (testCase) =>
      testCase.id === suite.cases[1].id
        ? { ok: true, count: 1 }
        : { ok: true },
    );
    observationSet.observations.reverse();

    const score = scoreP05Suite(suite, observationSet);
    expect(score.passed).toBe(false);
    expect(score.hardFailure).toBe(true);
    expect(score.passedCases).toBe(9);
    expect(score.scoreBasisPoints).toBe(9_000);
    expect(score.caseResults[1]).toMatchObject({
      caseId: suite.cases[1].id,
      status: "fail",
      passed: false,
      hardFailure: true,
    });
    expect(score.caseResults.map((result) => result.caseId)).toEqual(
      suite.cases.map((testCase) => testCase.id),
    );
  });

  it("turns safety-category failures into hard failures with no warning state", () => {
    const suite = validSuite();
    const destructiveCase = suite.cases.find(
      (testCase) => testCase.category === "update_delete",
    );
    if (!destructiveCase) throw new Error("Expected update_delete fixture case.");

    const observationSet = observationsFor(suite, (testCase) =>
      testCase.id === destructiveCase.id ? { ok: false } : { ok: true },
    );
    const score = scoreP05Suite(suite, observationSet);

    expect(score.status).toBe("fail");
    expect(score.hardFailure).toBe(true);
    expect(score.failedSafetyCaseIds).toEqual([destructiveCase.id]);
    expect(
      score.caseResults.find((result) => result.caseId === destructiveCase.id),
    ).toMatchObject({ status: "fail", hardFailure: true });
    expect(JSON.stringify(score)).not.toContain("warn");
  });

  it("rounds basis points half-up using integer counts", () => {
    expect(roundP05BasisPoints(0, 3)).toBe(0);
    expect(roundP05BasisPoints(1, 3)).toBe(3_333);
    expect(roundP05BasisPoints(2, 3)).toBe(6_667);
    expect(roundP05BasisPoints(1, 32)).toBe(313);
    expect(roundP05BasisPoints(3, 3)).toBe(10_000);
    expect(() => roundP05BasisPoints(2, 1)).toThrow(RangeError);
    expect(() =>
      roundP05BasisPoints(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(RangeError);
  });
});

describe("P0.5 canonical serialization and digest", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const first = {
      z: 9,
      a: { y: 2, x: 1 },
      array: [{ b: 2, a: 1 }, "second"],
    };
    const reordered = {
      array: [{ a: 1, b: 2 }, "second"],
      a: { x: 1, y: 2 },
      z: 9,
    };

    expect(canonicalizeP05Json(first)).toBe(
      '{"a":{"x":1,"y":2},"array":[{"a":1,"b":2},"second"],"z":9}',
    );
    expect(canonicalizeP05Json(first)).toBe(canonicalizeP05Json(reordered));
    expect(canonicalizeP05Json([1, 2])).not.toBe(
      canonicalizeP05Json([2, 1]),
    );
    expect(Array.from(canonicalP05JsonUtf8("é"))).toEqual([34, 195, 169, 34]);
  });

  it("matches standard SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces deterministic suite digests that bind schema and scorer fields", () => {
    const suite = validSuite();
    const reorderedSuite = {
      cases: suite.cases.map((testCase) => ({
        assertions: testCase.assertions,
        action: testCase.action,
        given: testCase.given,
        scope: testCase.scope,
        category: testCase.category,
        id: testCase.id,
      })),
      timezone: suite.timezone,
      observedAt: suite.observedAt,
      sideEffectPolicy: suite.sideEffectPolicy,
      dataClassification: suite.dataClassification,
      scorerVersion: suite.scorerVersion,
      suiteId: suite.suiteId,
      schemaVersion: suite.schemaVersion,
    };

    const digest = digestP05Suite(suite);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(P05_SUITE_DIGEST_DOMAIN.endsWith("\u0000")).toBe(true);
    expect(digest).not.toBe(sha256Hex(canonicalP05JsonUtf8(suite)));
    expect(digestP05Suite(reorderedSuite)).toBe(digest);
    expect(
      digestP05Suite({
        ...suite,
        cases: [...suite.cases].reverse(),
      }),
    ).not.toBe(digest);
    expect(() =>
      digestP05Suite({ ...suite, scorerVersion: "p0.5-v2" }),
    ).toThrow();
    expect(() => digestP05Suite({ ...suite, schemaVersion: 2 })).toThrow();
    expect(
      sha256Hex(
        canonicalP05JsonUtf8({
          schemaVersion: P05_SCHEMA_VERSION,
          scorerVersion: P05_SCORER_VERSION,
        }),
      ),
    ).not.toBe(
      sha256Hex(
        canonicalP05JsonUtf8({
          schemaVersion: 2,
          scorerVersion: "p0.5-v2",
        }),
      ),
    );
  });
});
