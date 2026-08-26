import type { Metadata } from "next";
import { MissionWorkspace } from "@/components/missions/mission-workspace";

export const metadata: Metadata = { title: "Missions" };

export default function MissionsPage() {
  return <MissionWorkspace />;
}
