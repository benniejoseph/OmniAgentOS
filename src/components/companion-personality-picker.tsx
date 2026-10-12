"use client";

import { Check, Coffee, Smile } from "lucide-react";
import { useCompanionPersonality, type CompanionPersonalityOwner } from "./use-companion-personality";
import styles from "./companion-personality-picker.module.css";

const choices = [
  { value: "butler", label: "Butler", description: "British poise and dry wit", sample: "Certainly. Let’s put the most pressing matter in order.", Icon: Coffee },
  { value: "playful", label: "Playful", description: "Quick wit and friendly banter", sample: "Right, let’s shrink that to-do list before it develops ambitions.", Icon: Smile },
] as const;

export function CompanionPersonalityPicker({ owner, disabled = false }: { owner: CompanionPersonalityOwner; disabled?: boolean }) {
  const { personality, setPersonality, persistenceNotice, available } = useCompanionPersonality(owner);
  return <fieldset className={styles.fieldset} disabled={disabled || !available}>
    <legend>Personality</legend>
    <p className={styles.help}>Choose the character behind ATLAS’s words and voice.</p>
    <div className={styles.choices}>
      {choices.map(({ value, label, description, sample, Icon }) => <button type="button" key={value}
        className={styles.choice} aria-pressed={personality === value} onClick={() => setPersonality(value)}>
        <span className={styles.title}><span><Icon size={19} aria-hidden="true" />{label}</span>{personality === value ? <Check size={18} aria-hidden="true" /> : null}</span>
        <span className={styles.description}>{description}</span>
        <span className={styles.sample}>“{sample}”</span>
      </button>)}
    </div>
    <p className={styles.help}>Saved on this device for your account. Your next message or new voice call uses this choice. A voice call already in progress keeps its personality.</p>
    {persistenceNotice ? <p className={styles.help} role="status">{persistenceNotice}</p> : null}
  </fieldset>;
}
