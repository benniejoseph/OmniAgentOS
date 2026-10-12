"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import type { ConversationVoiceProps } from "./conversation-voice";
import styles from "./voice-mode.module.css";

export function ConversationVoiceLauncher(props: ConversationVoiceProps) {
  return <VoiceLauncher key={props.authorityScope} {...props} />;
}

function VoiceLauncher(props: ConversationVoiceProps) {
  const [Voice, setVoice] = useState<ComponentType<ConversationVoiceProps>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function open() {
    if (loading || props.disabled || !props.isAuthorityCurrent()) return;
    setLoading(true);
    setError("");
    try {
      const voiceModule = await import("./conversation-voice");
      if (!mounted.current || !props.isAuthorityCurrent()) return;
      props.onOpen?.();
      setVoice(() => voiceModule.ConversationVoice);
    } catch {
      if (mounted.current && props.isAuthorityCurrent()) {
        setError("Voice could not load. Select the voice button to try again.");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  if (Voice) return <Voice {...props} initiallyOpen={!props.disabled && props.isAuthorityCurrent()} />;
  return <>
    <button type="button" className={styles.trigger} disabled={props.disabled || loading}
      title={props.disabledReason || "Start a voice conversation"}
      aria-label={loading ? "Loading voice conversation" : `Start voice conversation with ${props.agentName}`}
      aria-haspopup="dialog" aria-expanded={false} aria-busy={loading}
      onClick={() => void open()}>
      {loading ? <Loader2 size={17} aria-hidden="true" /> : <AudioLines size={17} aria-hidden="true" />}
    </button>
    {loading ? <span className="sr-only" role="status">Loading voice conversation…</span> : null}
    {error ? <span role="alert">{error}</span> : null}
  </>;
}
