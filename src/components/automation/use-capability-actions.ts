import { useCallback, useLayoutEffect, useState } from "react";
import { createCapabilityEffectGate, type CapabilityAttempt } from "./capability-state";

export function useCapabilityActions() {
  const [gate] = useState(createCapabilityEffectGate);
  const [pending, setPending] = useState<string>();
  useLayoutEffect(() => {
    gate.mount();
    return () => gate.dispose();
  }, [gate]);
  const begin = useCallback((name: string) => {
    const attempt = gate.begin(name);
    if (attempt) setPending(name);
    return attempt;
  }, [gate]);
  const finish = useCallback((attempt: CapabilityAttempt) => {
    if (gate.finish(attempt)) setPending(undefined);
  }, [gate]);
  return { pending, begin, finish, current: gate.current };
}

export type CapabilityActions = ReturnType<typeof useCapabilityActions>;
