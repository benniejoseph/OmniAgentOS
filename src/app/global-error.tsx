"use client";

import { useEffect } from "react";

/**
 * Replaces the whole document when the root layout itself fails. It carries
 * no app styles, since they may be what failed, and follows the system's
 * light or dark setting.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Asael failed to render", error);
  }, [error]);

  return (
    <html lang="en" style={{ colorScheme: "light dark" }}>
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif" }}>
        <title>Asael is unavailable</title>
        <main style={{ maxWidth: 480, padding: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Asael could not open</h1>
          <p style={{ fontSize: 16, lineHeight: 1.5 }}>
            Something went wrong while loading the app. Nothing you saved was lost.
          </p>
          <button type="button" onClick={() => retry()} style={{ fontSize: 16, minHeight: 44, padding: "0 16px" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
