import type { Metadata } from "next";
import { PublicHeader } from "@/components/marketing/public-header";
import { DemoWorkspace } from "@/components/onboarding/demo-workspace";
import styles from "@/components/onboarding/demo-workspace.module.css";

export const metadata: Metadata = {
  title: "Demo Workspace",
};

export default function DemoPage() {
  return (
    <>
      <a href="#main-content" className={`${styles.button} ${styles.skip}`}>Skip to demo</a>
      <PublicHeader inFlow />
      <DemoWorkspace />
    </>
  );
}
