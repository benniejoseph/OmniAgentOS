import type { Metadata } from "next";
import { MonitoringWorkspace } from "@/components/operations-console/monitoring-workspace";

export const metadata: Metadata = {
  title: "Monitoring",
};

export default function ObservabilityPage() {
  return <MonitoringWorkspace />;
}
