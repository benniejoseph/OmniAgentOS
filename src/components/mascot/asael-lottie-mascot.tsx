"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clsx } from "clsx";
import { AtlasLottie, atlasThemeSnapshot, subscribeAtlasTheme } from "@/components/companion-atlas-lottie";
import type { CompanionState } from "@/lib/companion/presentation";
import styles from "@/components/mascot/asael-lottie-mascot.module.css";

export type AsaelMascotState = "idle" | "thinking" | "listening" | "success" | "attention";
export type AsaelMascotSize = "tiny" | "small" | "medium" | "large" | "hero";

const stateMap: Record<AsaelMascotState, CompanionState> = {
  idle: "available", thinking: "working", listening: "listening", success: "completed", attention: "needs_you",
};
const labels: Record<AsaelMascotState, string> = {
  idle: "ATLAS is ready", thinking: "ATLAS is working", listening: "ATLAS is listening", success: "ATLAS finished", attention: "ATLAS needs your attention",
};

/** Existing callers share ATLAS artwork and its visibility/motion safeguards. */
export function AsaelLottieMascot({ state = "idle", size = "medium", className, label, decorative = false }: {
  state?: AsaelMascotState;
  size?: AsaelMascotSize;
  className?: string;
  label?: string;
  decorative?: boolean;
}) {
  const theme = useSyncExternalStore(subscribeAtlasTheme, atlasThemeSnapshot, () => "light" as const);
  const previous = useRef(state);
  const [reaction, setReaction] = useState<object>();
  useEffect(() => {
    if (previous.current !== state) setReaction({});
    previous.current = state;
  }, [state]);
  return <span className={clsx(styles.mascot, styles[size], className)} data-state={state}
    role={decorative ? undefined : "img"} aria-label={decorative ? undefined : label || labels[state]} aria-hidden={decorative || undefined}>
    <AtlasLottie state={stateMap[state]} theme={theme} playbackKey={reaction} motionAllowed={state !== "idle"} />
  </span>;
}
