import Link from "next/link";
import { Brain, WifiOff } from "lucide-react";

export default function OfflinePage() {
  return <main className="offline-shell"><div><span><WifiOff size={24} aria-hidden="true" /></span><p>Connection unavailable</p><h1>Your capture inbox still works offline.</h1><p>Return to Capture to queue a note locally. Asael will send it to your private knowledge system when the connection returns.</p><div><Link href="/app/capture"><Brain size={15} aria-hidden="true" /> Open Capture</Link><Link href="/app">Try again</Link></div></div></main>;
}
