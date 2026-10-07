import type { Metadata } from "next";
import { ResponsibilityWorkspace } from "@/components/responsibilities/responsibilities-workspace";
export const metadata: Metadata = { title: "Follow-ups" };
export default function ResponsibilitiesPage() {
  return <ResponsibilityWorkspace deployment={process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local"} />;
}
