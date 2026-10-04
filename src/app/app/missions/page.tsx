import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { MissionHistory } from "@/components/missions/mission-history";
import MissionsLoading from "./loading";

export const metadata: Metadata = { title: "Mission history" };

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (query.legacy !== "1") redirect("/app/projects?view=execution");
  return <Suspense fallback={<MissionsLoading />}><MissionHistory /></Suspense>;
}
