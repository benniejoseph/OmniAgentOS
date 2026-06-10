import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Evaluations",
};

export default function EvaluationsPage() {
  return <FeaturePage pageKey="evaluations" />;
}
