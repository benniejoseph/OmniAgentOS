import { redirect } from "next/navigation";

export default function EvaluationsPage() {
  redirect("/app/settings?section=quality");
}
