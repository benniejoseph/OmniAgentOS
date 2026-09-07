import type { Metadata } from "next";

import { CustomerAccountsWorkspace } from "@/components/customer-accounts-workspace";

export const metadata: Metadata = { title: "Customer account" };

export default async function CustomerAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <CustomerAccountsWorkspace initialAccountId={decodeURIComponent((await params).id)} />;
}
