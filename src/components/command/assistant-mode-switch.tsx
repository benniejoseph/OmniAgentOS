"use client";

import { useId } from "react";
import { Code2, MessageCircle, Workflow } from "lucide-react";
import { ASSISTANT_MODES, ASSISTANT_MODE_DETAILS, assistantMode, type AgentMode, type AssistantMode } from "@/lib/orchestration/modes";
import styles from "./assistant-mode-switch.module.css";

const icons = { chat: MessageCircle, cowork: Workflow, coding: Code2 };

export function AssistantModeSwitch({ mode, disabled, onChange }: {
  mode: AgentMode;
  disabled?: boolean;
  onChange: (mode: AssistantMode) => void;
}) {
  const name = useId();
  const selected = assistantMode(mode);
  return <fieldset className={styles.switch} disabled={disabled}>
    <legend className="sr-only">Assistant mode</legend>
    {ASSISTANT_MODES.map(value => {
      const Icon = icons[value];
      return <label key={value} className={styles.choice}>
        <input type="radio" name={name} value={value} checked={selected === value}
          onChange={() => onChange(value)} />
        <span><Icon size={16} aria-hidden="true" />{ASSISTANT_MODE_DETAILS[value].label}</span>
      </label>;
    })}
  </fieldset>;
}
