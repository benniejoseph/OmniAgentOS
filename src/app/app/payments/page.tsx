import type { Metadata } from "next";

import { PaymentsWorkspace } from "@/components/payments-workspace";

export const metadata: Metadata = {
  title: "Payments",
};

export default function PaymentsPage() {
  return <PaymentsWorkspace />;
}
