import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Connectors",
};

export default function ConnectorsPage() {
  return <FeaturePage pageKey="connectors" />;
}
