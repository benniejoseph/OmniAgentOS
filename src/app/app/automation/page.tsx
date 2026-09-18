import type { Metadata } from "next";
import { Suspense } from "react";
import {
  AutomationStudio,
  AutomationStudioFallback,
} from "@/components/automation/automation-studio";

export const metadata: Metadata = {
  title: "Automation",
};

export default function AutomationPage() {
  return (
    <Suspense fallback={<AutomationStudioFallback />}>
      <AutomationStudio />
    </Suspense>
  );
}
