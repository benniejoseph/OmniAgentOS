import type { Metadata } from "next";
import { ResponsibilityWorkspace } from "@/components/responsibilities/responsibilities-workspace";
export const metadata: Metadata = { title: "Responsibility" };
export default async function ResponsibilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // This installed router retains encoded path segments. Decode once; malformed
  // escapes stay an invalid, nonempty selection instead of becoming a new draft.
  let exactId: string;
  try { exactId = decodeURIComponent(id); } catch { exactId = "invalid-responsibility-route"; }
  return <ResponsibilityWorkspace id={exactId} deployment={process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local"} />;
}
