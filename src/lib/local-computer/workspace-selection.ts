import { z } from "zod";

export const localWorkspaceIdSchema = z.string().regex(/^local_workspace_[a-f0-9]{32}$/);

/** Select only from the catalog published by this authenticated native device. */
export function selectLocalWorkspace<T extends { id: string; name: string }>(
  workspaces: readonly T[], selectedId?: string,
): readonly T[] {
  if (!selectedId) return workspaces;
  localWorkspaceIdSchema.parse(selectedId);
  const selected = workspaces.find(workspace => workspace.id === selectedId);
  if (!selected) throw new Error("The selected folder is no longer available on this Mac. Choose it again.");
  return [selected];
}
