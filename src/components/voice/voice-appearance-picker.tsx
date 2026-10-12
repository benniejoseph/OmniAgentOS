"use client";

import Image from "next/image";
import { useSyncExternalStore } from "react";
import { Check, MicOff, PhoneOff } from "lucide-react";
import { atlasThemeSnapshot, subscribeAtlasTheme } from "@/components/companion-atlas-lottie";
import { atlasLottieAsset } from "@/lib/companion/atlas-lottie";
import { useVoiceAppearance, type VoiceAppearanceOwner } from "./use-voice-appearance";
import styles from "./voice-appearance-picker.module.css";

export function VoiceAppearancePicker({ owner, disabled = false }: { owner: VoiceAppearanceOwner; disabled?: boolean }) {
  const { appearance, setAppearance, persistenceNotice } = useVoiceAppearance(owner);
  const theme = useSyncExternalStore(subscribeAtlasTheme, atlasThemeSnapshot, () => "light" as const);
  return <fieldset className={styles.fieldset} disabled={disabled}>
    <legend>Voice appearance</legend>
    <p className={styles.help}>Choose how ATLAS keeps you company during a voice conversation.</p>
    <div className={styles.choices}>
      {(["companion", "perch"] as const).map((value) => <button type="button" key={value} className={styles.choice}
        aria-pressed={appearance === value} onClick={() => setAppearance(value)}>
        <span className={styles.preview} data-appearance={value} aria-hidden="true">
          <span className={styles.previewDock}>
            <Image className={styles.character} src={atlasLottieAsset("listening", theme, "svg")} width={80} height={80} alt="" unoptimized />
            <span className={styles.previewCaption}><strong>ATLAS</strong><span>Listening</span></span>
            <span className={styles.previewControls}><MicOff size={12} /><PhoneOff size={12} /></span>
          </span>
        </span>
        <span className={styles.choiceTitle}>{value === "companion" ? "Companion" : "Perch"}{appearance === value ? <Check size={17} aria-hidden="true" /> : null}</span>
        <span className={styles.description}>{value === "companion" ? "A compact dock, close at hand." : "A free-standing character with room to express."}</span>
      </button>)}
    </div>
    {persistenceNotice ? <p className={styles.help} role="status">{persistenceNotice}</p> : null}
    <p className={styles.help}>Applies immediately on this device, including an open voice conversation. You can switch any time. Microphone and motion settings stay the same.</p>
  </fieldset>;
}
