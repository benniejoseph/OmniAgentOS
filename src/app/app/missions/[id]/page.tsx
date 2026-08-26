import type { Metadata } from "next";
import { MissionWorkspace } from "@/components/missions/mission-workspace";

export const metadata: Metadata = { title: "Mission" };

export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MissionWorkspace initialMissionId={id} />;
}
