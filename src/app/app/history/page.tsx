import type { Metadata } from "next";
import { Suspense } from "react";
import { HistoryWorkspace } from "@/components/history-workspace";

export const metadata: Metadata = { title: "History" };

export default function HistoryPage() {
  return <Suspense fallback={<p role="status">Opening History…</p>}><HistoryWorkspace /></Suspense>;
}
