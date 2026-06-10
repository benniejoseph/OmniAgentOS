import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Approvals",
};

export default function ApprovalsPage() {
  return <DomainConsole domain="approvals" />;
}
