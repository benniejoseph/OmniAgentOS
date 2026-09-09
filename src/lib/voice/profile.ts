import { createHash } from "node:crypto";

export const ASAEL_VOICE_PROFILE_VERSION = "asael-voice:1" as const;
export const ASAEL_VOICE_NAME = "cedar" as const;
export const ASAEL_VOICE_SAMPLE_RATE = 24_000 as const;
export const ASAEL_VOICE_ENCODING = "pcm_s16le" as const;

export type AgentSpeechIdentity = Readonly<{
  id: string;
  name: string;
  delivery: string;
  definitionVersion: number;
}>;

export type VersionedVoiceProfile = Readonly<{
  schemaVersion: 1;
  profileVersion: typeof ASAEL_VOICE_PROFILE_VERSION;
  provider: "openai";
  model: string;
  voice: typeof ASAEL_VOICE_NAME;
  sampleRate: typeof ASAEL_VOICE_SAMPLE_RATE;
  encoding: typeof ASAEL_VOICE_ENCODING;
  agentId: string;
  agentDefinitionVersion: number;
  instructions: string;
  sha256: string;
}>;

export function versionedVoiceProfile(
  identity: AgentSpeechIdentity,
  runtime: Readonly<{ provider: "openai"; model: string }>,
): VersionedVoiceProfile {
  const agentId = boundedToken(identity.id, "asael");
  const name = boundedText(identity.name, 120) || "Asael";
  const delivery = boundedText(identity.delivery, 500) ||
    "Clear, calm, direct, and explicit about uncertainty.";
  const agentDefinitionVersion = Number.isSafeInteger(identity.definitionVersion) &&
      identity.definitionVersion > 0
    ? identity.definitionVersion
    : 1;
  const model = boundedToken(runtime.model, "");
  if (!model) throw new Error("The speech synthesis model route is invalid.");
  const profile = {
    schemaVersion: 1 as const,
    profileVersion: ASAEL_VOICE_PROFILE_VERSION,
    provider: runtime.provider,
    model,
    voice: ASAEL_VOICE_NAME,
    sampleRate: ASAEL_VOICE_SAMPLE_RATE,
    encoding: ASAEL_VOICE_ENCODING,
    agentId,
    agentDefinitionVersion,
    instructions:
      `Read the supplied text exactly as written. Do not add, omit, summarize, or answer it. ` +
      `Use ${name}'s delivery: ${delivery}`,
  };
  return {
    ...profile,
    sha256: createHash("sha256")
      .update(JSON.stringify(profile), "utf8")
      .digest("hex"),
  };
}

function boundedToken(value: string, fallback: string) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(normalized)
    ? normalized
    : fallback;
}

function boundedText(value: string, maxLength: number) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
