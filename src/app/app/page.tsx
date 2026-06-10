import type { Metadata } from "next";
import { DashboardOverview } from "@/components/app-shell/dashboard-overview";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default function AppDashboardPage() {
  return <DashboardOverview />;
}
