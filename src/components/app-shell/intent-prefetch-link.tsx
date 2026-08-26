"use client";

import Link from "next/link";
import { useState } from "react";
import type { ComponentProps } from "react";

type IntentPrefetchLinkProps = Omit<ComponentProps<typeof Link>, "prefetch">;

/**
 * Avoid eager viewport prefetches for Asael's database-backed workspace while
 * retaining fast navigation once the user signals intent with hover or focus.
 */
export function IntentPrefetchLink({
  onFocus,
  onMouseEnter,
  ...props
}: IntentPrefetchLinkProps) {
  const [active, setActive] = useState(false);

  return (
    <Link
      {...props}
      prefetch={active ? null : false}
      onMouseEnter={(event) => {
        setActive(true);
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        setActive(true);
        onFocus?.(event);
      }}
    />
  );
}
