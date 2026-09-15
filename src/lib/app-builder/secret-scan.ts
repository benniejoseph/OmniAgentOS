import { createHash } from "node:crypto";
import {
  APP_BUILDER_SECRET_SCAN_CONTRACT_VERSION,
  type AppBuilderFile,
} from "@/lib/app-builder/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type AppBuilderSecretFinding = Readonly<{
  path: string;
  line: number;
  rule: string;
}>;

export type AppBuilderSecretScan = Readonly<{
  contractVersion: typeof APP_BUILDER_SECRET_SCAN_CONTRACT_VERSION;
  status: "passed" | "blocked";
  fileCount: number;
  byteCount: number;
  findingCount: number;
  findings: readonly AppBuilderSecretFinding[];
  manifestSha256: string;
  scanSha256: string;
}>;

const lineRules = [
  { id: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: "openai_key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
] as const;

const assignmentPattern = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?([^"'\s#]{12,})/i;
const safeAssignmentValues = /^(?:example|sample|placeholder|replace[_-]?me|your[_-]|test[_-]|dummy|undefined|null|false|true|\$\{|process\.env)/i;

export function scanBuilderFilesForSecrets(files: readonly AppBuilderFile[]): AppBuilderSecretScan {
  const findings: AppBuilderSecretFinding[] = [];
  let byteCount = 0;
  const manifest = files
    .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const file of files) {
    byteCount += file.size;
    for (const [index, line] of file.content.split(/\r?\n/).entries()) {
      for (const rule of lineRules) {
        if (rule.pattern.test(line)) findings.push({ path: file.path, line: index + 1, rule: rule.id });
      }
      const assignment = assignmentPattern.exec(line);
      if (assignment && !safeAssignmentValues.test(assignment[1])) {
        findings.push({ path: file.path, line: index + 1, rule: "credential_assignment" });
      }
    }
  }

  const unique = [...new Map(
    findings.map((finding) => [`${finding.path}:${finding.line}:${finding.rule}`, finding]),
  ).values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
  );
  const manifestSha256 = canonicalJsonSha256(manifest);
  const scanSha256 = createHash("sha256").update(JSON.stringify({
    contractVersion: APP_BUILDER_SECRET_SCAN_CONTRACT_VERSION,
    manifestSha256,
    findings: unique,
  })).digest("hex");

  return {
    contractVersion: APP_BUILDER_SECRET_SCAN_CONTRACT_VERSION,
    status: unique.length ? "blocked" : "passed",
    fileCount: files.length,
    byteCount,
    findingCount: unique.length,
    findings: unique,
    manifestSha256,
    scanSha256,
  };
}
