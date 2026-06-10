import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Security",
};

export default function SecurityPage() {
  return <DomainConsole domain="security" />;
}
