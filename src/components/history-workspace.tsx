"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { FileText, History } from "lucide-react";
import { ActivityWorkspace } from "@/components/activity-workspace";
import { ResultsCenter } from "@/components/results-center";
import styles from "./history-workspace.module.css";

export function HistoryWorkspace() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get("view");
  const view = requested === "timeline" || requested === "results"
    ? requested
    : pathname === "/app/activity" ? "timeline" : "results";

  function href(next: "results" | "timeline") {
    const query = new URLSearchParams(searchParams.toString());
    query.set("view", next);
    return `/app/history?${query}`;
  }

  return <section className={styles.workspace} aria-labelledby="history-title">
    <header className={styles.header}>
      <span className={styles.mark} aria-hidden="true"><History size={25} /></span>
      <div><h1 id="history-title">History</h1>
        <p>Find what Asael created and follow how the work unfolded.</p></div>
    </header>
    <nav className={styles.tabs} aria-label="History views">
      <span className={styles.selection} data-view={view} aria-hidden="true" />
      <Link href={href("results")} prefetch={false} aria-current={view === "results" ? "page" : undefined}>
        <FileText size={18} aria-hidden="true" /><span>Results</span>
      </Link>
      <Link href={href("timeline")} prefetch={false} aria-current={view === "timeline" ? "page" : undefined}>
        <History size={18} aria-hidden="true" /><span>Timeline</span>
      </Link>
    </nav>
    <div key={view} className={styles.content}>
      {view === "results" ? <ResultsCenter embedded /> : <ActivityWorkspace embedded />}
    </div>
  </section>;
}
