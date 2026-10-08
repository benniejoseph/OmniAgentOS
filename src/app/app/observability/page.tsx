import { redirect } from "next/navigation";

export default function ObservabilityPage() {
  redirect("/app/settings?section=monitoring");
}
