import type { Metadata } from "next";
import { MemoryWorkspace } from "@/components/memory-workspace";

export const metadata: Metadata = {
  title: "Memory",
};

export default function MemoryPage() {
  return <MemoryWorkspace />;
}
