import { describe, expect, it } from "vitest";
import { selectLocalWorkspace } from "./workspace-selection";
import { promptQueueTargetV1Schema } from "@/lib/command/prompt-queue-contracts";

const one = `local_workspace_${"1".repeat(32)}`;
const two = `local_workspace_${"2".repeat(32)}`;
describe("selected Mac project", () => {
  it("advertises only the selected device grant", () => {
    const workspaces = [{ id: one, name: "One" }, { id: two, name: "Two" }];
    expect(selectLocalWorkspace(workspaces, two)).toEqual([workspaces[1]]);
    expect(selectLocalWorkspace(workspaces)).toEqual(workspaces);
  });
  it("refuses a removed, foreign or malformed folder instead of falling back", () => {
    expect(() => selectLocalWorkspace([{ id: one, name: "One" }], two)).toThrow("no longer available");
    expect(() => selectLocalWorkspace([], "../folder")).toThrow();
  });
  it("keeps the selected folder in a queued Mac request and rejects a target mismatch", () => {
    const target = { threadId: null, missionId: null, projectId: null, executionTarget: "local_macos", localWorkspaceId: one };
    expect(promptQueueTargetV1Schema.parse(target)).toEqual(target);
    expect(promptQueueTargetV1Schema.safeParse({ ...target, executionTarget: "asael" }).success).toBe(false);
    expect(promptQueueTargetV1Schema.safeParse({ ...target, executionTarget: "local_android" }).success).toBe(false);
  });
});
