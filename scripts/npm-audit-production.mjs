import { spawn } from "node:child_process";
import path from "node:path";

const MAX_ATTEMPTS = 3;
const TRANSIENT_AUDIT_FAILURE =
  /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|audit endpoint returned an error|audit request .* failed/i;

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const auditRuntimeDirectory =
  process.env.OMNIAGENT_AUDIT_RUNTIME_DIR?.trim();
const npmCommand = auditRuntimeDirectory
  ? path.join(auditRuntimeDirectory, npmExecutable)
  : npmExecutable;
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)),
);
const auditPath = auditRuntimeDirectory
  ? [auditRuntimeDirectory, cleanEnvironment.PATH]
      .filter(Boolean)
      .join(path.delimiter)
  : cleanEnvironment.PATH;
const nodeOptions = [
  process.env.NODE_OPTIONS,
  "--dns-result-order=ipv4first",
]
  .filter(Boolean)
  .join(" ");

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const result = await runAudit();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.code === 0) {
    if (attempt > 1) {
      console.log(`Production dependency audit passed on attempt ${attempt}.`);
    }
    process.exit(0);
  }

  const isTransient = TRANSIENT_AUDIT_FAILURE.test(
    `${result.stdout}\n${result.stderr}`,
  );
  if (!isTransient || attempt === MAX_ATTEMPTS) {
    process.exit(result.code || 1);
  }

  console.warn(
    `Production dependency audit transport failed on attempt ${attempt}; retrying.`,
  );
  await wait(attempt * 1_000);
}

function runAudit() {
  return new Promise((resolve) => {
    const child = spawn(
      npmCommand,
      ["audit", "--omit=dev", "--audit-level=high"],
      {
        cwd: process.cwd(),
        env: {
          ...cleanEnvironment,
          PATH: auditPath,
          NODE_OPTIONS: nodeOptions,
          npm_config_fetch_retries:
            process.env.npm_config_fetch_retries || "3",
          npm_config_fetch_retry_mintimeout:
            process.env.npm_config_fetch_retry_mintimeout || "1000",
          npm_config_fetch_retry_maxtimeout:
            process.env.npm_config_fetch_retry_maxtimeout || "10000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
