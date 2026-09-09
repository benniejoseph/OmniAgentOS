import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from "@/lib/config";
import { embedTextsWithRuntime } from "@/lib/openai/client";
import type { AiUsageScope } from "@/lib/usage/types";

export const LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS = 384;
export const LOCAL_MULTILINGUAL_EMBEDDING_MODEL =
  "asael-multilingual-feature-hash:1" as const;
export const LOCAL_MULTILINGUAL_EMBEDDING_SPACE =
  `${LOCAL_MULTILINGUAL_EMBEDDING_MODEL}:${LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS}` as const;

export type RetrievalEmbeddingProviderId = "local" | "openai";

export type RetrievalEmbeddingCapability = Readonly<{
  provider: RetrievalEmbeddingProviderId;
  model: string;
  spaceId: string;
  dimensions: number;
  multilingual: boolean;
  externalDisclosure: boolean;
  requiresCredential: boolean;
  supportsStoredVectorIndex: boolean;
}>;

export type RetrievalEmbeddingReceipt = RetrievalEmbeddingCapability &
  Readonly<{
    version: "p4.4-retrieval-embedding:1";
    inputCount: number;
    fallbackReason?:
      | "external_provider_not_allowed"
      | "external_provider_unavailable"
      | "external_provider_failed";
  }>;

export type RetrievalEmbeddingResult = Readonly<{
  vectors: number[][];
  receipt: RetrievalEmbeddingReceipt;
}>;

export type RetrievalEmbeddingOptions = Readonly<{
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
  /** External providers require an explicit disclosure-policy allowlist. */
  allowedExternalProviders?: readonly Exclude<
    RetrievalEmbeddingProviderId,
    "local"
  >[];
}>;

export const retrievalEmbeddingCapabilities = Object.freeze({
  local: Object.freeze(localCapability()),
  openai: Object.freeze(openAICapability()),
});

export async function embedRetrievalTexts(
  input: readonly string[],
  options: RetrievalEmbeddingOptions = {},
): Promise<RetrievalEmbeddingResult> {
  const normalizedInput = input.map((value) => String(value).slice(0, 20_000));
  const openAIAllowed = options.allowedExternalProviders?.includes("openai") ===
    true;
  if (openAIAllowed) {
    try {
      const embedded = await embedTextsWithRuntime(
        [...normalizedInput],
        options.abortSignal,
        options.usageScope,
      );
      if (embedded?.vectors.length === normalizedInput.length) {
        return {
          vectors: embedded.vectors,
          receipt: receipt(
            openAICapability(embedded.model, embedded.dimensions),
            normalizedInput.length,
          ),
        };
      }
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      return localEmbeddingResult(
        normalizedInput,
        "external_provider_failed",
      );
    }
  }

  return localEmbeddingResult(
    normalizedInput,
    openAIAllowed
      ? "external_provider_unavailable"
      : "external_provider_not_allowed",
  );
}

export function embedLocalMultilingualTexts(
  input: readonly string[],
): number[][] {
  return input.map(localMultilingualEmbedding);
}

export function localMultilingualEmbedding(value: string) {
  const vector = Array<number>(LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS).fill(0);
  const tokens = multilingualTokens(value);
  const canonicalTokens = tokens.map((token) => CONCEPT_BY_ALIAS.get(token) || token);

  for (const token of tokens) addFeature(vector, `token:${token}`, 0.7);
  for (const token of canonicalTokens) addFeature(vector, `concept:${token}`, 2.4);
  for (let index = 0; index < canonicalTokens.length - 1; index += 1) {
    addFeature(
      vector,
      `pair:${canonicalTokens[index]}:${canonicalTokens[index + 1]}`,
      0.9,
    );
  }
  for (const token of tokens) {
    if (token.length < 4) continue;
    const padded = `^${token}$`;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      addFeature(vector, `tri:${padded.slice(index, index + 3)}`, 0.18);
    }
  }

  return normalizeVector(vector);
}

export function retrievalEmbeddingCosine(
  left: readonly number[],
  right: readonly number[],
) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator ? dot / denominator : 0;
}

export function isLocalRetrievalEmbeddingSpace(spaceId?: string) {
  return spaceId === LOCAL_MULTILINGUAL_EMBEDDING_SPACE;
}

export function retrievalEmbeddingSpaceSupportsStoredVectorIndex(
  spaceId?: string,
) {
  return !spaceId || (
    spaceId.startsWith("openai:") &&
    spaceId.endsWith(`:${EMBEDDING_DIMENSIONS}`)
  );
}

function localEmbeddingResult(
  input: readonly string[],
  fallbackReason: RetrievalEmbeddingReceipt["fallbackReason"],
): RetrievalEmbeddingResult {
  return {
    vectors: embedLocalMultilingualTexts(input),
    receipt: receipt(localCapability(), input.length, fallbackReason),
  };
}

function receipt(
  capability: RetrievalEmbeddingCapability,
  inputCount: number,
  fallbackReason?: RetrievalEmbeddingReceipt["fallbackReason"],
): RetrievalEmbeddingReceipt {
  return {
    version: "p4.4-retrieval-embedding:1",
    ...capability,
    inputCount,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function localCapability(): RetrievalEmbeddingCapability {
  return {
    provider: "local",
    model: LOCAL_MULTILINGUAL_EMBEDDING_MODEL,
    spaceId: LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
    dimensions: LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS,
    multilingual: true,
    externalDisclosure: false,
    requiresCredential: false,
    supportsStoredVectorIndex: false,
  };
}

function openAICapability(
  model = EMBEDDING_MODEL,
  dimensions = EMBEDDING_DIMENSIONS,
): RetrievalEmbeddingCapability {
  return {
    provider: "openai",
    model,
    spaceId: `openai:${model}:${dimensions}`,
    dimensions,
    multilingual: true,
    externalDisclosure: true,
    requiresCredential: true,
    supportsStoredVectorIndex: true,
  };
}

function multilingualTokens(value: string) {
  return String(value)
    .normalize("NFKD")
    .toLocaleLowerCase("und")
    .replace(/\p{M}+/gu, "")
    .match(/[\p{L}\p{N}]+/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length > 1 && !MULTILINGUAL_STOP_WORDS.has(token))
    .slice(0, 256) || [];
}

function addFeature(vector: number[], feature: string, weight: number) {
  const hash = fnv1a(feature);
  const index = hash % vector.length;
  const sign = hash & 0x80000000 ? -1 : 1;
  vector[index] += weight * sign;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude ? vector.map((value) => value / magnitude) : vector;
}

const CONCEPT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  backup: ["backup", "copia", "sauvegarde", "sicherung", "backup-copia", "बैकअप"],
  billing: ["billing", "facturacion", "facturation", "abrechnung", "cobranca", "बिलिंग"],
  contract: ["contract", "contrato", "contrat", "vertrag", "अनुबंध"],
  customer: ["customer", "cliente", "client", "kunde", "ग्राहक"],
  database: ["database", "base", "donnees", "datenbank", "banco", "डेटाबेस"],
  deployment: ["deploy", "deployment", "desplegar", "despliegue", "deployer", "deploiement", "bereitstellung", "implantacao", "तैनात", "परिनियोजन"],
  failed: ["failed", "failure", "fallo", "echec", "fehler", "falha", "विफल"],
  incident: ["incident", "incidente", "vorfall", "घटना"],
  invoice: ["invoice", "factura", "facture", "rechnung", "fatura", "चालान"],
  latest: ["latest", "current", "ultimo", "actual", "recent", "aktuell", "atual", "नवीनतम"],
  meeting: ["meeting", "reunion", "besprechung", "reuniao", "बैठक"],
  owner: ["owner", "owned", "propietario", "dueno", "proprietaire", "eigentumer", "proprietario", "मालिक"],
  password: ["password", "contrasena", "motdepasse", "passwort", "senha", "पासवर्ड"],
  procedure: ["procedure", "process", "steps", "procedimiento", "proceso", "etapes", "verfahren", "processo", "प्रक्रिया"],
  project: ["project", "proyecto", "projet", "projekt", "projeto", "परियोजना"],
  renewal: ["renewal", "renovacion", "renouvellement", "verlangerung", "renovacao", "नवीनीकरण"],
  restore: ["restore", "restaurar", "restaurer", "wiederherstellen", "restauracao", "बहाल"],
  rotate: ["rotate", "rotation", "rotar", "rotation-fr", "wechseln", "girar", "बदलें"],
  status: ["status", "estado", "statut", "zustand", "स्थिति"],
  worker: ["worker", "trabajador", "agent", "arbeiter", "processador", "कार्यकर्ता"],
};

const CONCEPT_BY_ALIAS = new Map(
  Object.entries(CONCEPT_ALIASES).flatMap(([concept, aliases]) =>
    aliases.map((alias) => [normalizeAlias(alias), concept] as const)
  ),
);

function normalizeAlias(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("und")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const MULTILINGUAL_STOP_WORDS = new Set([
  "and", "are", "for", "the", "with",
  "de", "del", "el", "la", "las", "los", "para", "por", "y",
  "des", "du", "et", "la", "le", "les", "pour",
  "der", "die", "das", "den", "fur", "mit", "und",
  "da", "de", "do", "e", "o", "os", "para",
  "का", "की", "के", "और", "लिए",
]);
