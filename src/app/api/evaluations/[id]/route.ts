import { getEvalRunDetail } from "@/lib/evaluations/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = await getEvalRunDetail(id);

  if (!detail) {
    return Response.json({ error: "Evaluation run not found." }, { status: 404 });
  }

  return Response.json(detail);
}
