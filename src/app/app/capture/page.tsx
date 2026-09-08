import type { Metadata } from "next";
import { CaptureWorkspace } from "@/components/capture-workspace";

export const metadata: Metadata = {
  title: "Capture",
};

export default function CapturePage() {
  return <CaptureWorkspace />;
}
