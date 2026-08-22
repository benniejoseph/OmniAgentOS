import type { Metadata } from "next";
import { ApprovalsWorkspace } from "@/components/approvals-workspace";

export const metadata: Metadata = {
  title: "Inbox",
};

export default function ApprovalsPage() {
  return <ApprovalsWorkspace />;
}
