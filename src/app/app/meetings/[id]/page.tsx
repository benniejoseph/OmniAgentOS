import type { Metadata } from "next";

import { MeetingsWorkspace } from "@/components/meetings-workspace";

export const metadata: Metadata = { title: "Meeting" };

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <MeetingsWorkspace initialMeetingId={decodeURIComponent((await params).id)} />;
}
