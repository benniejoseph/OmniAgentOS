import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Knowledge",
};

export default function MemoryPage() {
  return <DomainConsole domain="knowledge" />;
}
