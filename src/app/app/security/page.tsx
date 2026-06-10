import type { Metadata } from "next";
import { FeaturePage } from "@/components/app-shell/feature-page";

export const metadata: Metadata = {
  title: "Security",
};

export default function SecurityPage() {
  return <FeaturePage pageKey="security" />;
}
