import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Observability",
};

export default function ObservabilityPage() {
  return <FeaturePage pageKey="observability" />;
}
