import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Monitoring",
};

export default function ObservabilityPage() {
  return <DomainConsole domain="monitoring" />;
}
