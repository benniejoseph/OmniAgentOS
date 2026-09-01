import type { Metadata } from "next";
import { IntegrationsWorkspace } from "@/components/integrations/integrations-workspace";

export const metadata: Metadata = {
  title: "Integrations",
};

export default function ConnectorsPage() {
  return <IntegrationsWorkspace />;
}
