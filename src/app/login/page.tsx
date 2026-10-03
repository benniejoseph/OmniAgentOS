import type { Metadata } from "next";
import { AccessShell } from "@/components/access-recovery/access-shell";
import { LoginForm } from "@/components/onboarding/login-form";

export const metadata: Metadata = {
  title: "Private Sign In",
  description: "Sign in to your private Asael workspace.",
};

export default function LoginPage() {
  return (
    <AccessShell>
      <LoginForm />
    </AccessShell>
  );
}
