/** Synthetic, deterministic server-authored interoperability fixtures. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPortableArchiveV2,
  portableJsonSha256,
  portableTextSha256,
  type PortableArchiveDataV2,
} from "../src/lib/data/portable-contract";
import { sourceContractSha256 } from "../src/lib/sources/contracts";

// Run from the repository root, matching the existing generator commands.
const root = path.resolve(process.cwd());
const output = path.join(root, "apps/flutter/test/fixtures/portable_archive");
const check = process.argv.includes("--check");
const exportedAt = "2026-10-05T00:00:00.000Z";
const sourceTenantId = "tenant-portable-fixture";
const sourceOwnerActorId = "archive@example.test";
const emptyData = (): PortableArchiveDataV2 => ({
  knowledge: [], memories: [], threads: [], today: [], projects: [],
  connections: [], skills: [], agents: [], assets: [],
});
const text = "Synthetic archive text: 🦉, e\u0301, é, \\, \"quoted\",\nline, \u0000, \ud800, \udfff.";
const memoryText = "Synthetic bounded memory content. This is not account data.";
const turnText = "Synthetic conversation turn 🦉.";
const data = emptyData();
data.knowledge.push({
  sourceId: "fixture-knowledge", title: "Synthetic knowledge 🦉", content: text,
  contentSha256: portableTextSha256(text), source: "synthetic", sourceType: "text",
  tags: ["fixture", "unicode"], sourceContentSha256: null,
  sourceRevisionIdSha256: portableTextSha256("synthetic-revision"), updatedAt: exportedAt,
});
data.memories.push({
  sourceId: "fixture-memory", title: "Synthetic memory", content: memoryText,
  contentSha256: portableTextSha256(memoryText), type: "decision", tier: "decision",
  tierPolicyVersion: 1, formationReason: "explicit_user_request", tags: ["fixture"],
  scope: "user", source: "synthetic", importance: 0.000001, confidence: 1.0,
  claimStatus: "active", assertedBy: "user", evidenceRefs: ["fixture:observation"],
  validFrom: null, validTo: null, retentionExpiresAt: null, lastUsedAt: exportedAt,
  useCount: 9007199254740991, promotedFromTier: null, promotedAt: null,
  supersedesId: null, contradictionOfId: null, createdAt: exportedAt, updatedAt: exportedAt,
}, {
  sourceId: "fixture-memory-optional-absent", title: "Optional fields absent",
  content: "Synthetic optional-field case.", contentSha256: portableTextSha256("Synthetic optional-field case."),
  type: "fact", tags: [], scope: "project", source: "", importance: -0, confidence: 1e-7,
  claimStatus: "candidate", assertedBy: "import", evidenceRefs: [], validFrom: null, validTo: null,
  supersedesId: "fixture-memory", contradictionOfId: null, createdAt: null, updatedAt: null,
});
data.threads.push({
  sourceIdSha256: portableTextSha256("fixture-thread"), title: "Synthetic thread", mode: "learn",
  turns: [{ index: 0, role: "user", content: turnText, contentSha256: portableTextSha256(turnText), createdAt: null },
    { index: 1, role: "assistant", content: "Synthetic response.", contentSha256: portableTextSha256("Synthetic response."), createdAt: exportedAt }],
});
data.today.push({ sourceIdSha256: portableTextSha256("fixture-today"), title: "Synthetic reminder", kind: "reminder", priority: "medium", status: "open", dueAt: null });
data.projects.push({
  sourceIdSha256: portableTextSha256("fixture-project"), title: "Synthetic project", objective: "Verify synthetic interoperability.", status: "draft", targetDate: null,
  tasks: [{ sourceIdSha256: portableTextSha256("fixture-task"), title: "Synthetic task", detail: "", priority: "low", agentId: "atlas", origin: "manual", dueAt: exportedAt }],
});
data.connections.push({ provider: "synthetic_provider", scopes: ["fixture.read"], configurationSha256: portableJsonSha256({ synthetic: true }), reauthorizationRequired: true });
data.skills.push({ sourceId: "fixture-skill", name: "Synthetic skill", description: "Synthetic skill description.", instructions: "Synthetic instructions used only for archive verification fixtures.", category: "analysis", status: "disabled", toolIds: ["fixture.read"], tags: [], knowledgeTags: [] });
data.agents.push({ sourceId: "fixture-agent", name: "Synthetic Agent", role: "Synthetic role", description: "Synthetic Agent description.", instructions: "Synthetic instructions used only for archive verification fixtures.", status: "paused", accent: "violet", modelPolicy: "auto", autonomy: "assist", approvalPolicy: "read_only", memoryScope: "session", skillIds: ["fixture-skill"], toolIds: [] });

const input = { exportedAt, sourceOwnerActorId, sourceTenantId };
const minimal = buildPortableArchiveV2({ ...input, data: emptyData() });
const populated = buildPortableArchiveV2({
  ...input, data, excludedCounts: { knowledge: 3, memories: null, assets: 2 },
  exclusions: [
    { category: "memories", reason: "bounded_source_window", count: null },
    { category: "assets", reason: "not_requested", count: 2 },
    { category: "secrets", reason: "always_excluded", count: null },
  ],
});

// The private source serializer is not exported. Produce a readable spelling
// using JSON.stringify's primitives and independently bind it to both exported
// authoritative hash functions, which fail generation if this helper diverges.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Fixtures require JSON values.");
  return serialized;
}
const cases: { name: string; inputJson: string; canonicalJson: string; sha256: string }[] = [];
function add(name: string, inputJson: string) {
  const value: unknown = JSON.parse(inputJson);
  const canonicalJson = canonical(value);
  const sha256 = sourceContractSha256(value);
  if (sha256 !== createHash("sha256").update(canonicalJson).digest("hex") || sha256 !== portableJsonSha256(value)) {
    throw new Error(`Authoritative canonical fixture disagreement: ${name}`);
  }
  cases.push({ name, inputJson, canonicalJson, sha256 });
}
[
  "0", "-0", "1.0", "-1.0", "0.1", "0.000001", "0.0000001", "1e-5", "1e-6", "1e-7",
  "1e20", "1e21", "1e22", "-1e21", "1000000000000000100", "9007199254740991", "9007199254740993",
  "333333333.33333329", "0.84551240822557006", "2.9802322387695312e-8", "1.2345678901234567",
  "5e-324", "-5e-324", "2.2250738585072014e-308", "2.225073858507201e-308", "1.7976931348623157e308",
  "1.0000000000000002", "0.9999999999999999", "9.999999999999999e-7", "9.999999999999999e20",
].forEach((number, index) => add(`number-${index}`, number));
add("null-and-booleans", '[null,true,false]');
add("optional-null-and-order", '{"z":null,"a":{"last":false,"first":1.0},"empty":{},"list":[null,0,-0]}');
add("utf16-key-order", '{"\ue000":1,"🦉":2,"a":3,"\ud800":4,"\udfff":5,"𐀀":6,"0":7,"10":8,"2":9}');
add("escaping", JSON.stringify('"\\/\b\f\n\r\t\u0000\u001f\u2028\u2029🦉\ud800\udfff\ud800A\udfff'));
add("unicode-not-normalized", JSON.stringify(["é", "e\u0301", "Å", "A\u030a"]));
// Cover deterministic binary64 neighborhoods without relying on Dart's number
// printer to create the expected result. No random/account material is used.
let bits = BigInt("0x6a09e667f3bcc909");
for (let index = 0; index < 512; index++) {
  bits ^= bits << BigInt(13);
  bits ^= bits >> BigInt(7);
  bits ^= bits << BigInt(17);
  bits = BigInt.asUintN(64, bits);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(bits);
  const number = buffer.readDoubleBE();
  if (Number.isFinite(number)) add(`binary64-${index}`, JSON.stringify(number));
}

const files: Record<string, string> = {
  "minimal.json": `${JSON.stringify(minimal, null, 2)}\n`,
  "populated.json": `${JSON.stringify(populated, null, 2)}\n`,
  "canonical-corpus.json": `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`,
};
const sourcePaths = ["src/lib/data/portable-contract.ts", "src/lib/sources/contracts.ts", "scripts/generate-portable-archive-native-fixtures.ts"];
async function main() {
  files["provenance.json"] = `${JSON.stringify({
  schemaVersion: 1, synthetic: true, tenantId: sourceTenantId, actorId: sourceOwnerActorId,
  exportedAt, generator: "scripts/generate-portable-archive-native-fixtures.ts",
  command: "node --import tsx scripts/generate-portable-archive-native-fixtures.ts",
  sourceSha256: Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")]))),
  fileSha256: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, createHash("sha256").update(value).digest("hex")])),
  limitations: "Synthetic interoperability evidence, not a production backup or signature.",
}, null, 2)}\n`;
if (!check) await mkdir(output, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const filename = path.join(output, name);
  if (check) {
    if (await readFile(filename, "utf8") !== value) throw new Error(`Stale portable archive fixture: ${name}`);
  } else {
    await writeFile(filename, value);
  }
}
  console.log(`${check ? "Verified" : "Generated"} ${Object.keys(files).length} synthetic portable archive fixture files (${cases.length} canonical cases).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Portable archive fixture generation failed.");
  process.exitCode = 1;
});
