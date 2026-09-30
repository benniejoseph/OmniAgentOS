import { createHash } from "node:crypto";
import { recordMissionArtifact, type MissionOwner } from "@/lib/missions/store";
import { durableSpecialistLabel } from "@/lib/subagents/profiles";
import type { DurableSpecialistAgentId } from "@/lib/subagents/types";

const MAX_SPECIALIST_FINDINGS_CHARS = 12_000;

/** What a durable specialist's mission attempt keeps of its response. */
export function durableSpecialistReceipt(
  agentId: DurableSpecialistAgentId,
  response = "",
) {
  return {
    agentId,
    responseLength: response.length,
    responseSha256: createHash("sha256").update(response).digest("hex"),
  };
}

/**
 * Keeps a completed specialist's findings where its parent workflow reads
 * them. The findings are keyed by run, so recording them again changes
 * nothing.
 */
export async function recordDurableSpecialistFindings(
  input: {
    missionId: string;
    taskId: string;
    runId: string;
    agentId: DurableSpecialistAgentId;
    response?: string;
  },
  owner: MissionOwner,
) {
  const response = input.response || "";
  return recordMissionArtifact({
    ...owner,
    missionId: input.missionId,
    taskId: input.taskId,
    sourceKey: `subagent:${input.runId}:result`,
    kind: "specialist_result",
    title: `${durableSpecialistLabel(input.agentId).name} · durable findings`,
    mimeType: "text/plain",
    data: {
      ...durableSpecialistReceipt(input.agentId, response),
      response: response.slice(0, MAX_SPECIALIST_FINDINGS_CHARS),
    },
  });
}
