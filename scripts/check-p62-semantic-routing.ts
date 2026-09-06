import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { runWithDatabaseActorScope } from "../src/lib/db/client";
import { searchCapabilities } from "../src/lib/capabilities/catalog";
import { generateModelText } from "../src/lib/models/gateway";
import {
  evaluateSemanticRoutingBenchmark,
  semanticRoutingSuiteSchema,
  type SemanticRoutingObservation,
} from "../src/lib/evals2/semantic-routing";
import {
  createSemanticIntentResolver,
  resolveSemanticIntent,
} from "../src/lib/orchestration/semantic-intent-resolver";
import { routeAgentRequest } from "../src/lib/orchestration/supervisor";
import { createExecutionScope } from "../src/lib/security/execution-scope";
import { resolveRuntimeModelAssignment } from "../src/lib/settings/runtime-models";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim() ||
    process.env.OMNIAGENT_BACKUP_DATABASE_URL?.trim();
  if (databaseUrl && !process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL = databaseUrl;
  }
  const benchmarkScope = await resolveBenchmarkScope(databaseUrl);
  const tenantId = benchmarkScope.tenantId;
  const actorId = benchmarkScope.actorId;

  const fixturePath = resolve(
    process.cwd(),
    "evals/p62/semantic-routing.v1.json",
  );
  const suite = semanticRoutingSuiteSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  );
  const selectedCaseId = process.env.P62_BENCHMARK_CASE_ID?.trim();
  const selectedCases = selectedCaseId
    ? suite.cases.filter((testCase) => testCase.id === selectedCaseId)
    : suite.cases;
  if (selectedCaseId && !selectedCases.length) {
    throw new Error(`Unknown semantic-routing case: ${selectedCaseId}`);
  }
  const semanticResolver = process.env.P62_DIAGNOSTIC === "1"
    ? diagnosticResolver()
    : resolveSemanticIntent;

  const observations: SemanticRoutingObservation[] = [];
  for (const [index, testCase] of selectedCases.entries()) {
    const requestId = `p62-${Date.now()}-${index}`;
    const baseline = routeAgentRequest(testCase.utterance, testCase.mode);
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: requestId,
      purpose: "evaluation.p6_2.semantic_routing",
    });
    const resolution = await runWithDatabaseActorScope(
      tenantId,
      [actorId],
      () => semanticResolver({
        tenantId,
        actorId,
        requestId,
        message: testCase.utterance,
        recentConversation: [{ role: "user", content: testCase.utterance }],
        mode: testCase.mode,
        baseline,
        executionScope,
      }),
    );
    observations.push({
      caseId: testCase.id,
      route: resolution.decision.route,
      matchedCapabilityIds: [...resolution.receipt.matchedCapabilityIds],
      source: resolution.receipt.source,
      intent: resolution.receipt.intent,
      executionShape: resolution.receipt.executionShape,
    });
  }

  if (selectedCaseId) {
    process.stdout.write(`${JSON.stringify({ observations }, null, 2)}\n`);
    return;
  }

  const report = evaluateSemanticRoutingBenchmark(suite, observations);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

function diagnosticResolver() {
  return createSemanticIntentResolver({
    async searchCapabilities(input) {
      const startedAt = Date.now();
      const result = await searchCapabilities(input);
      process.stderr.write(`${JSON.stringify({
        stage: "capability_search",
        durationMs: Date.now() - startedAt,
        count: result.capabilities.length,
      })}\n`);
      return result;
    },
    async resolveRuntimeModelAssignment(input) {
      const startedAt = Date.now();
      const result = await resolveRuntimeModelAssignment(input);
      process.stderr.write(`${JSON.stringify({
        stage: "model_resolution",
        durationMs: Date.now() - startedAt,
        configured: result.configured,
        source: result.source,
        provider: result.provider || null,
        model: result.model || null,
      })}\n`);
      return result;
    },
    async generateModelText(input) {
      const startedAt = Date.now();
      try {
        const result = await generateModelText(input);
        process.stderr.write(`${JSON.stringify({
          stage: "model_generation",
          durationMs: Date.now() - startedAt,
          provider: result.provider,
          model: result.model,
          usageReceiptRecorded: result.usageReceiptRecorded === true,
        })}\n`);
        return result;
      } catch (error) {
        const detail = error && typeof error === "object"
          ? error as Record<string, unknown>
          : {};
        process.stderr.write(`${JSON.stringify({
          stage: "model_generation",
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "unknown",
          failureKind: typeof detail.kind === "string" ? detail.kind : null,
          retryable: typeof detail.retryable === "boolean"
            ? detail.retryable
            : null,
          status: typeof detail.status === "number" ? detail.status : null,
        })}\n`);
        throw error;
      }
    },
  });
}

async function resolveBenchmarkScope(databaseUrl?: string) {
  const configuredTenantId = process.env.P62_BENCHMARK_TENANT_ID?.trim();
  const configuredActorId = process.env.P62_BENCHMARK_ACTOR_ID?.trim();
  if (configuredTenantId && configuredActorId) {
    return { tenantId: configuredTenantId, actorId: configuredActorId };
  }
  if (configuredTenantId || configuredActorId) {
    throw new Error(
      "Configure both P62_BENCHMARK_TENANT_ID and P62_BENCHMARK_ACTOR_ID, or neither.",
    );
  }
  if (!databaseUrl) {
    throw new Error(
      "A database URL is required to resolve the benchmark tenant and actor.",
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<Array<{ tenant_id: string; actor_id: string }>>`
      SELECT
        membership.tenant_id,
        COALESCE(auth_user.actor_id, auth_user.id) AS actor_id
      FROM omni_auth_memberships membership
      JOIN omni_auth_users auth_user
        ON auth_user.id = membership.user_id
      WHERE membership.status = 'active'
        AND auth_user.status = 'active'
      ORDER BY
        CASE WHEN membership.role = 'admin' THEN 0 ELSE 1 END,
        membership.created_at ASC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new Error("No active benchmark actor was found.");
    return { tenantId: row.tenant_id, actorId: row.actor_id };
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Benchmark failed."}\n`);
  process.exitCode = 1;
});
