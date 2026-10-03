import type { Metadata } from "next";
import { ActivityWorkspace } from "@/components/activity-workspace";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return <ActivityWorkspace />;
}
