import type { Metadata } from "next";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { LoginForm } from "@/components/onboarding/login-form";

export const metadata: Metadata = {
  title: "Private Sign In",
  description: "Sign in to the private OmniAgent owner workspace.",
};

export default function LoginPage() {
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  );
}
