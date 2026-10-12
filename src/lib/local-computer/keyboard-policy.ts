import keyboardPolicy from "@/lib/local-computer/keyboard-policy.json";

// These are named ANSI-position keys, not a text encoder. Text entry always
// uses local.macos.type so the current keyboard layout cannot corrupt text.
export const LOCAL_COMPUTER_KEY_NAMES = Object.freeze([
  ...Object.keys(keyboardPolicy.keys),
  ...Object.keys(keyboardPolicy.aliases),
]);

const legacyKeys: ReadonlySet<string> = new Set(keyboardPolicy.legacyKeys);

export function localComputerKeyNeedsV52(key: unknown) {
  return typeof key === "string" && !legacyKeys.has(key);
}
