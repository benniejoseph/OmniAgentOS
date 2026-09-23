import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Capabilities",
};

export default function ToolsPage() {
  redirect("/app/automation");
}
