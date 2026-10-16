import type { Metadata } from "next";
import { WatchesWorkspace } from "@/components/watches/watches-workspace";
export const metadata: Metadata = { title: "Watches" };
export default function WatchesPage() {
  return <WatchesWorkspace deployment={process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local"} />;
}
