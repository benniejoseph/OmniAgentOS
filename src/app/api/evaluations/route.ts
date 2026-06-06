import { z } from "zod";
import { defaultEvalCases, runEvaluationSuite } from "@/lib/evaluations/runner";
import { getEvalStats, listEvalRuns } from "@/lib/evaluations/store";

export const runtime = "nodejs";

const evalRunSchema = z.object({
  suite: z.string().min(1).max(80).optional(),
  caseIds: z.array(z.string().min(1)).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  return Response.json({
    cases: defaultEvalCases,
    runs: await listEvalRuns(limit),
    stats: await getEvalStats(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = evalRunSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid evaluation run request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const detail = await runEvaluationSuite({
    suite: parsed.data.suite || "core",
    caseIds: parsed.data.caseIds,
  });

  return Response.json(detail, { status: detail?.run.status === "failed" ? 202 : 201 });
}
