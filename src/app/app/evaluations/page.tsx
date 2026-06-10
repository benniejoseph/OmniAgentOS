import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Evaluations",
};

export default function EvaluationsPage() {
  return <DomainConsole domain="evaluations" />;
}
