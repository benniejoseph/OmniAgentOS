import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { listSecurityAudits } from "@/lib/security/audit-store";
import type { SecurityAuditRecord } from "@/lib/security/types";

export type SignedAuditExport = {
  format: "asael-signed-audit";
  version: 1;
  tenantId: string;
  exportedAt: string;
  algorithm: "sha256+hmac-sha256";
  keyId: string;
  entries: Array<{ sequence: number; previousHash: string; hash: string; record: SecurityAuditRecord }>;
  rootHash: string;
  signature: string;
};

export async function createSignedAuditExport(tenantId: string, limit = 5_000): Promise<SignedAuditExport> {
  const secret = signingSecret();
  const exportedAt = new Date().toISOString();
  const records = (await listSecurityAudits({ tenantId, limit: Math.min(Math.max(limit, 1), 10_000) })).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  let previousHash = "0".repeat(64);
  const entries = records.map((record, index) => {
    const hash = createHash("sha256").update(`${previousHash}\n${canonicalJson(record)}`).digest("hex");
    const entry = { sequence: index + 1, previousHash, hash, record };
    previousHash = hash;
    return entry;
  });
  const rootHash = entries.at(-1)?.hash || previousHash;
  const keyId = process.env.OMNIAGENT_REPORT_SIGNING_KEY_ID?.trim() || "asael-report-signing-secret";
  const signature = createHmac("sha256", secret).update(signaturePayload(tenantId, exportedAt, rootHash, entries.length)).digest("base64url");
  return { format: "asael-signed-audit", version: 1, tenantId, exportedAt, algorithm: "sha256+hmac-sha256", keyId, entries, rootHash, signature };
}

export function verifySignedAuditExport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "Audit export must be an object." };
  const report = value as Partial<SignedAuditExport>;
  if (report.format !== "asael-signed-audit" || report.version !== 1 || !Array.isArray(report.entries) || typeof report.tenantId !== "string" || typeof report.exportedAt !== "string" || typeof report.signature !== "string") return { valid: false, error: "Unsupported audit export." };
  let previousHash = "0".repeat(64);
  for (let index = 0; index < report.entries.length; index += 1) {
    const entry = report.entries[index];
    const expected = createHash("sha256").update(`${previousHash}\n${canonicalJson(entry.record)}`).digest("hex");
    if (entry.sequence !== index + 1 || entry.previousHash !== previousHash || entry.hash !== expected) return { valid: false, error: `Audit chain mismatch at sequence ${index + 1}.` };
    previousHash = expected;
  }
  if (report.rootHash !== previousHash) return { valid: false, error: "Audit root hash does not match the record chain." };
  const expectedSignature = createHmac("sha256", signingSecret()).update(signaturePayload(report.tenantId, report.exportedAt, previousHash, report.entries.length)).digest("base64url");
  const actual = Buffer.from(report.signature);
  const expected = Buffer.from(expectedSignature);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { valid: true, records: report.entries.length, rootHash: previousHash }
    : { valid: false, error: "Audit signature is invalid." };
}

function signingSecret() {
  const secret = process.env.OMNIAGENT_REPORT_SIGNING_SECRET?.trim();
  if (!secret) throw new Error("OMNIAGENT_REPORT_SIGNING_SECRET is required for signed audit exports.");
  return secret;
}

function signaturePayload(tenantId: string, exportedAt: string, rootHash: string, count: number) {
  return `${tenantId}\n${exportedAt}\n${rootHash}\n${count}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
