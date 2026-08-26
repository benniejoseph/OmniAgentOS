/**
 * Evaluate the browser dashboard release gate without depending on Playwright.
 * Keeping the math pure makes the small-sample percentile and every independent
 * budget enforceable in unit tests.
 */
export function evaluateDashboardReleaseGate({
  firstLoad,
  recoveryLoad,
  hotMeasurements,
  warmups,
  minimumSamples,
  budgets,
}) {
  const normalizedFirstLoad = normalizeMeasurement(firstLoad, "first load");
  const normalizedRecoveryLoad = normalizeMeasurement(
    recoveryLoad,
    "recovery load",
  );
  const normalizedHotMeasurements = hotMeasurements.map((measurement, index) =>
    normalizeMeasurement(measurement, `hot sample ${index + 1}`),
  );
  if (!normalizedHotMeasurements.length) {
    throw new Error("Dashboard release gate requires at least one hot sample.");
  }

  const normalizedWarmups = positiveInteger(warmups, "warmups");
  if (normalizedWarmups < 2) {
    throw new Error(
      "Dashboard release gate requires at least two warmups so recovery is measured.",
    );
  }
  const normalizedMinimumSamples = positiveInteger(
    minimumSamples,
    "minimumSamples",
  );
  const normalizedBudgets = normalizeBudgets(budgets);
  if (normalizedBudgets.firstLoadTargetMs > normalizedBudgets.firstLoadMs) {
    throw new Error(
      "Dashboard first-load optimization target cannot exceed its release ceiling.",
    );
  }
  const hotDurationsMs = normalizedHotMeasurements.map(
    (measurement) => measurement.durationMs,
  );
  const documentDurationsMs = normalizedHotMeasurements.map(
    (measurement) => measurement.documentResponseMs,
  );
  const serverDurationsMs = normalizedHotMeasurements
    .map((measurement) => measurement.serverDurationMs)
    .filter(Number.isFinite);

  const p50Ms = nearestRankPercentile(hotDurationsMs, 0.5);
  const p95Ms = nearestRankPercentile(hotDurationsMs, 0.95);
  const maxMs = Math.ceil(Math.max(...hotDurationsMs));
  const documentP50Ms = nearestRankPercentile(documentDurationsMs, 0.5);
  const documentP95Ms = nearestRankPercentile(documentDurationsMs, 0.95);
  const documentMaxMs = Math.ceil(Math.max(...documentDurationsMs));
  const firstLoadMs = Math.ceil(normalizedFirstLoad.durationMs);
  const firstResponseMs = Math.ceil(normalizedFirstLoad.documentResponseMs);
  if (
    normalizedFirstLoad.documentResponseMs > normalizedFirstLoad.durationMs
  ) {
    throw new Error(
      "Dashboard first-load response time cannot exceed its usable duration.",
    );
  }
  const firstPostResponseReadyMs = Math.ceil(
    normalizedFirstLoad.durationMs - normalizedFirstLoad.documentResponseMs,
  );
  const recoveryLoadMs = Math.ceil(normalizedRecoveryLoad.durationMs);
  const firstLoadTargetMet =
    firstLoadMs <= normalizedBudgets.firstLoadTargetMs;
  const checks = {
    sampleCount: normalizedHotMeasurements.length >= normalizedMinimumSamples,
    firstLoad: firstLoadMs <= normalizedBudgets.firstLoadMs,
    firstResponse: firstResponseMs <= normalizedBudgets.firstResponseMs,
    firstPostResponseReady:
      firstPostResponseReadyMs <= normalizedBudgets.firstPostResponseReadyMs,
    recoveryLoad: recoveryLoadMs <= normalizedBudgets.recoveryLoadMs,
    hotP50: p50Ms <= normalizedBudgets.hotP50Ms,
    hotP95: p95Ms <= normalizedBudgets.hotP95Ms,
    hotMax: maxMs <= normalizedBudgets.hotMaxMs,
    documentP95: documentP95Ms <= normalizedBudgets.documentP95Ms,
  };
  const serverTimingCoverage =
    serverDurationsMs.length === 0
      ? "none"
      : serverDurationsMs.length === normalizedHotMeasurements.length
        ? "complete"
        : "partial";

  return {
    samples: normalizedHotMeasurements.length,
    minimumSamples: normalizedMinimumSamples,
    warmups: normalizedWarmups,
    firstLoad: normalizedFirstLoad,
    firstLoadMs,
    firstLoadTargetMet,
    firstResponseMs,
    firstPostResponseReadyMs,
    recoveryLoad: normalizedRecoveryLoad,
    recoveryLoadMs,
    hotDurationsMs,
    documentDurationsMs,
    serverDurationsMs,
    p50Ms,
    p95Ms,
    maxMs,
    documentP50Ms,
    documentP95Ms,
    documentMaxMs,
    serverTiming: {
      coverage: serverTimingCoverage,
      samples: serverDurationsMs.length,
      p50Ms: serverDurationsMs.length
        ? nearestRankPercentile(serverDurationsMs, 0.5)
        : undefined,
      p95Ms: serverDurationsMs.length
        ? nearestRankPercentile(serverDurationsMs, 0.95)
        : undefined,
      maxMs: serverDurationsMs.length
        ? Math.ceil(Math.max(...serverDurationsMs))
        : undefined,
    },
    budgets: normalizedBudgets,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

export function nearestRankPercentile(values, quantile) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Percentile calculation requires at least one value.");
  }
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("Percentile quantile must be greater than 0 and at most 1.");
  }
  const sorted = values.map((value, index) =>
    finiteNonNegative(value, `percentile value ${index + 1}`),
  ).sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  // Round latency upward so a fractional overage cannot pass a millisecond
  // budget merely because its display value rounded down.
  return Math.ceil(sorted[index]);
}

function normalizeMeasurement(measurement, label) {
  if (!measurement || typeof measurement !== "object") {
    throw new Error(`Dashboard ${label} measurement is required.`);
  }
  const durationMs = finiteNonNegative(
    measurement.durationMs,
    `${label} durationMs`,
  );
  const documentResponseMs = finiteNonNegative(
    measurement.documentResponseMs,
    `${label} documentResponseMs`,
  );
  const serverDurationMs = Number.isFinite(measurement.serverDurationMs)
    ? finiteNonNegative(
        measurement.serverDurationMs,
        `${label} serverDurationMs`,
      )
    : undefined;
  return {
    durationMs,
    documentResponseMs,
    ...(serverDurationMs === undefined ? {} : { serverDurationMs }),
  };
}

function normalizeBudgets(budgets) {
  if (!budgets || typeof budgets !== "object") {
    throw new Error("Dashboard release budgets are required.");
  }
  return {
    firstLoadTargetMs: finiteNonNegative(
      budgets.firstLoadTargetMs,
      "first-load target",
    ),
    firstLoadMs: finiteNonNegative(budgets.firstLoadMs, "first-load budget"),
    firstResponseMs: finiteNonNegative(
      budgets.firstResponseMs,
      "first-response budget",
    ),
    firstPostResponseReadyMs: finiteNonNegative(
      budgets.firstPostResponseReadyMs,
      "first post-response-ready budget",
    ),
    recoveryLoadMs: finiteNonNegative(
      budgets.recoveryLoadMs,
      "recovery-load budget",
    ),
    hotP50Ms: finiteNonNegative(budgets.hotP50Ms, "hot p50 budget"),
    hotP95Ms: finiteNonNegative(budgets.hotP95Ms, "hot p95 budget"),
    hotMaxMs: finiteNonNegative(budgets.hotMaxMs, "hot max budget"),
    documentP95Ms: finiteNonNegative(
      budgets.documentP95Ms,
      "document p95 budget",
    ),
  };
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Dashboard ${label} must be a positive integer.`);
  }
  return value;
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Dashboard ${label} must be a finite non-negative number.`);
  }
  return value;
}
