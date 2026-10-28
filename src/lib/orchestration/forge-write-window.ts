import type { ToolExecutionRecord } from "@/lib/tools/types";
import type { AgentEvent } from "./types";

const discoveryTools = new Set(["app.projects.builder.tree", "app.projects.builder.search"]);
const mutationTools = new Set([
  "app.projects.builder.file.update", "app.projects.builder.file.edit", "app.projects.builder.file.delete",
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const FORGE_WRITE_WINDOW_REFUSAL = "Broad discovery is withdrawn in the final Forge write window. This call was not executed. Use permitted exact-file reads and governed edits, or honestly report that no justified change can be made.";

/** A restriction within the existing run, never a reservation or edit grant. */
export function createForgeWriteWindow(boundWritingForge: boolean) {
  let active = false;
  let mutationExecuted = false;
  return {
    enter(remainingToolRounds: number): Extract<AgentEvent, { type: "status" }> | undefined {
      if (!boundWritingForge || active || mutationExecuted || !Number.isSafeInteger(remainingToolRounds) || remainingToolRounds <= 0 || remainingToolRounds > 3) return undefined;
      active = true;
      return {
        type: "status", label: "Forge write window",
        detail: `${remainingToolRounds} existing tool rounds remain and no file mutation has executed. Broad tree/search discovery is withdrawn; exact reads, governed edits and an honest no-change answer remain available. No limit or approval changed.`,
      };
    },
    allows(toolId: string) { return !active || !discoveryTools.has(toolId); },
    instructions(remainingToolRounds: number) {
      return active && remainingToolRounds > 0
        ? `\n\nForge write window: ${remainingToolRounds} existing tool rounds remain. Broad tree/search discovery is withdrawn. Use the known plan and recorded evidence; read an exact file/range only if needed, then save a justified change through the permitted edit tools. Do not make a speculative edit. If no justified edit is possible, report no change honestly. Existing scope, approvals and all run limits still apply.`
        : "";
    },
    observeExecution(record: Pick<ToolExecutionRecord, "toolId" | "status" | "dryRun" | "input" | "output">) {
      if (record.status !== "executed" || record.dryRun || !mutationTools.has(record.toolId)) return;
      const deleted = record.toolId.endsWith(".delete"), output = object(record.output);
      const change = object(deleted ? output?.deletion : output?.update);
      if (!change || change.path !== record.input.path || change.previousSha256 !== record.input.expectedSha256 ||
          !(change.previousSha256 === null || digest(change.previousSha256))) return;
      const after = deleted ? null : change.sha256;
      // A no-op, preview or malformed result must not suppress the window.
      // Full durable effect verification still belongs to the Forge adapter.
      if ((after === null || digest(after)) && change.previousSha256 !== after) mutationExecuted = true;
    },
  };
}
