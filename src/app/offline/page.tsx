import Link from "next/link";
import { WifiOff } from "lucide-react";

export default function OfflinePage() {
  return <main className="offline-shell"><div><span><WifiOff size={24} aria-hidden="true" /></span><p>Connection unavailable</p><h1>You are offline.</h1><p>Pages open again when the connection returns. A Capture page that is already open still saves notes on this device and sends them once you are back online.</p><div><Link href="/app">Try again</Link></div></div></main>;
}
