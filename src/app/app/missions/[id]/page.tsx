import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { MissionHistory } from "@/components/missions/mission-history";
import { historyId } from "@/components/missions/mission-history-state";
import MissionsLoading from "../loading";

export const metadata: Metadata = { title: "Historical mission" };

export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!historyId(id)) redirect("/app/projects?view=execution");
  return <Suspense fallback={<MissionsLoading />}><MissionHistory /></Suspense>;
}
