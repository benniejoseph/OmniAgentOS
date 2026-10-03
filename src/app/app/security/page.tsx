import type { Metadata } from "next";
import { SecurityWorkspace } from "@/components/operations-console/security-workspace";

export const metadata: Metadata = {
  title: "Security",
};

export default function SecurityPage() {
  return <SecurityWorkspace />;
}
