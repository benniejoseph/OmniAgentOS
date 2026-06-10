import type { Metadata } from "next";
import { PublicHeader } from "@/components/marketing/public-header";
import { DemoWorkspace } from "@/components/onboarding/demo-workspace";

export const metadata: Metadata = {
  title: "Demo Workspace",
};

export default function DemoPage() {
  return (
    <>
      <PublicHeader />
      <DemoWorkspace />
    </>
  );
}
