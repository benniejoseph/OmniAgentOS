import type { Metadata } from "next";
import { WatchesWorkspace } from "@/components/watches/watches-workspace";
export const metadata: Metadata = { title: "Availability watch" };
export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WatchesWorkspace id={id} deployment={process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local"} />;
}
