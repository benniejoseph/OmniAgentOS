import type { Metadata } from "next";
import { TodayWorkspace } from "@/components/today-workspace";

export const metadata: Metadata = {
  title: "Today",
};

export default function AppDashboardPage() {
  return <TodayWorkspace />;
}
