"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clsx } from "clsx";
import type {
  LottieComponentProps,
  LottieRefCurrentProps,
} from "lottie-react";
import styles from "@/components/mascot/asael-lottie-mascot.module.css";

export type AsaelMascotState =
  | "idle"
  | "thinking"
  | "listening"
  | "success"
  | "attention";

export type AsaelMascotSize = "tiny" | "small" | "medium" | "large" | "hero";

type LottieAnimationData = LottieComponentProps["animationData"];

const LottiePlayer = dynamic<LottieComponentProps>(
  () => import("lottie-react").then((module) => module.default),
  { ssr: false },
);

const animationByState: Record<AsaelMascotState, string> = {
  idle: "/animations/asael-idle.json",
  thinking: "/animations/asael-thinking.json",
  listening: "/animations/asael-listening.json",
  success: "/animations/asael-success.json",
  attention: "/animations/asael-attention.json",
};

const labelByState: Record<AsaelMascotState, string> = {
  idle: "Asael is ready",
  thinking: "Asael is working",
  listening: "Asael is listening",
  success: "Asael finished",
  attention: "Asael needs your attention",
};

const loopByState: Record<AsaelMascotState, boolean> = {
  idle: true,
  thinking: true,
  listening: true,
  success: false,
  attention: true,
};

const speedByState: Record<AsaelMascotState, number> = {
  idle: 0.72,
  thinking: 1.18,
  listening: 0.94,
  success: 0.86,
  attention: 0.82,
};

export function AsaelLottieMascot({
  state = "idle",
  size = "medium",
  className,
  label,
  decorative = false,
}: {
  state?: AsaelMascotState;
  size?: AsaelMascotSize;
  className?: string;
  label?: string;
  decorative?: boolean;
}) {
  const [animation, setAnimation] = useState<{
    state: AsaelMascotState;
    data: LottieAnimationData;
  }>();
  const [renderedState, setRenderedState] = useState<AsaelMascotState | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const lottieRef = useRef<LottieRefCurrentProps | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(animationByState[state], { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Mascot animation unavailable");
        return response.json();
      })
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        if (!isLottieAnimationData(value)) throw new Error("Mascot animation unavailable");
        setAnimation({ state, data: value as LottieAnimationData });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnimation(undefined);
      });
    return () => controller.abort();
  }, [state]);

  // Animation data is keyed by state, so a state change shows the fallback
  // until that state's animation has loaded and rendered.
  const animationData = animation?.state === state ? animation.data : null;
  const loaded = animationData !== null && renderedState === state;

  return (
    <span
      className={clsx(styles.mascot, styles[size], className)}
      data-state={state}
      data-loaded={loaded || undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label || labelByState[state]}
      aria-hidden={decorative || undefined}
    >
      <span className={styles.fallback} aria-hidden="true">
        <svg viewBox="0 0 120 120" focusable="false">
          <ellipse className={styles.fallbackOrbit} cx="60" cy="60" rx="46" ry="26" />
          <circle className={styles.fallbackSatellite} cx="103" cy="51" r="4" />
          <circle className={styles.fallbackAura} cx="60" cy="60" r="31" />
          <circle className={styles.fallbackCore} cx="60" cy="60" r="23" />
          <path className={styles.fallbackPage} d="M48 44h19l8 8v25H48Z" />
          <path className={styles.fallbackFold} d="M67 44v9h8" />
          <path className={styles.fallbackLine} d="M54 59h14M54 66h10" />
          <circle className={styles.fallbackSpark} cx="31" cy="35" r="2.4" />
          <circle className={styles.fallbackSpark} cx="92" cy="83" r="1.8" />
        </svg>
      </span>
      {animationData ? (
        <span className={styles.player} aria-hidden="true">
          <LottiePlayer
            key={state}
            lottieRef={lottieRef}
            animationData={animationData}
            autoplay={!reducedMotion}
            loop={!reducedMotion && loopByState[state]}
            onDOMLoaded={() => {
              lottieRef.current?.setSpeed(speedByState[state]);
              if (reducedMotion) lottieRef.current?.goToAndStop(0, true);
              setRenderedState(state);
            }}
            renderer="svg"
            rendererSettings={{
              preserveAspectRatio: "xMidYMid meet",
              progressiveLoad: true,
            }}
            style={{ width: "100%", height: "100%" } as CSSProperties}
          />
        </span>
      ) : null}
    </span>
  );
}

function isLottieAnimationData(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.fr === "number" && Array.isArray(record.layers);
}
