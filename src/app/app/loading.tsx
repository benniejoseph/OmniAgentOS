import { RecoveryLoading } from "@/components/access-recovery/recovery-frame";

/**
 * Shown inside the workspace shell while a workspace view renders on the
 * server. Being a loading boundary also lets a hover or focus prefetch fetch
 * the route down to here, so opening a workspace shows this at once.
 */
export default function WorkspaceLoading() {
  return <RecoveryLoading title="Loading the workspace." description="The view is being prepared. Workspace navigation remains available." />;
}
