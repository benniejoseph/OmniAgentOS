import type { Metadata } from "next";
import { QualityWorkspace } from "@/components/operations-console/quality-workspace";

export const metadata: Metadata = {
  title: "Evaluations",
};

export default function EvaluationsPage() {
  return <QualityWorkspace />;
}
