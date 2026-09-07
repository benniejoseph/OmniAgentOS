import type { Metadata } from "next";

import { CustomerAccountsWorkspace } from "@/components/customer-accounts-workspace";

export const metadata: Metadata = { title: "Account 360" };

export default function CustomerAccountsPage() {
  return <CustomerAccountsWorkspace />;
}
