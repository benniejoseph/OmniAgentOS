import type { Metadata } from "next";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { SignupForm } from "@/components/onboarding/signup-form";

export const metadata: Metadata = {
  title: "Request Access",
};

export default function SignupPage() {
  return (
    <AuthShell
      eyebrow="Enterprise access"
      title="Request a governed AI workspace."
      summary="OmniAgentOS onboarding starts with one concrete workflow, one memory source, and the operating controls needed before agents touch production systems."
    >
      <SignupForm />
    </AuthShell>
  );
}
