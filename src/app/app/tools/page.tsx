import type { Metadata } from "next";
import { DomainConsole } from "@/components/app-shell/domain-console";

export const metadata: Metadata = {
  title: "Tool Catalog",
};

export default function ToolsPage() {
  return <DomainConsole domain="tools" />;
}
