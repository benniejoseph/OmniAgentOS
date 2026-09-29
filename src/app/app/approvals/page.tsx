import type { Metadata } from "next";
import { ApprovalsWorkspace } from "@/components/approvals-workspace";
import {
  parseApprovalFocusId,
  parseApprovalKind,
  safeApprovalReturnTo,
} from "@/lib/approvals/inbox-link";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[]; kind?: string | string[]; returnTo?: string | string[] }>;
}) {
  const query = await searchParams;
  const focusId = parseApprovalFocusId(query.id);
  const focusKind = focusId ? parseApprovalKind(query.kind) : undefined;
  const returnTo = safeApprovalReturnTo(query.returnTo);
  // A link to another item starts the inbox over rather than keeping the
  // state of the item opened before.
  return (
    <ApprovalsWorkspace
      key={focusId ? `${focusKind ?? "any"}:${focusId}` : "queue"}
      focusId={focusId}
      focusKind={focusKind}
      returnTo={returnTo}
    />
  );
}
