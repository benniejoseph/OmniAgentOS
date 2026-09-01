import type { Metadata } from "next";
import { ToolsWorkspace } from "@/components/tools/tools-workspace";

export const metadata: Metadata = {
  title: "Tools",
};

export default function ToolsPage() {
  return <ToolsWorkspace />;
}
