import type { Metadata } from "next";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { LoginForm } from "@/components/onboarding/login-form";

export const metadata: Metadata = {
  title: "Sign In",
};

export default function LoginPage() {
  return (
    <AuthShell
      eyebrow="Secure entry"
      title="Sign in to operate OmniAgentOS."
      summary="Authenticated operators can load production telemetry, run workflows, inspect release evidence, and continue onboarding from the enterprise workspace."
    >
      <LoginForm />
    </AuthShell>
  );
}
