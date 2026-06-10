import { AlertTriangle } from "lucide-react";
import { getStorageBackend } from "@/lib/db/client";

export function StorageWarning() {
  if (getStorageBackend() !== "ephemeral") {
    return null;
  }

  return (
    <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm sm:px-6 lg:px-8" role="alert">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle size={15} className="shrink-0 text-warning" aria-hidden="true" />
        No database is configured, so memories, runs, and workflows are stored in ephemeral instance storage and
        will be lost on the next cold start. Set DATABASE_URL to persist data.
      </p>
    </div>
  );
}
