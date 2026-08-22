import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const passwordVersion = "scrypt-v1";
const keyLength = 64;
export const MAX_PASSWORD_LENGTH = 1024;
const passwordVerifyConcurrency = boundedInteger(
  process.env.OMNIAGENT_PASSWORD_VERIFY_CONCURRENCY,
  4,
  1,
  16,
);
const passwordVerifyQueueLimit = boundedInteger(
  process.env.OMNIAGENT_PASSWORD_VERIFY_QUEUE_LIMIT,
  64,
  passwordVerifyConcurrency,
  512,
);
let activePasswordVerifications = 0;
const passwordVerificationWaiters: Array<() => void> = [];

export class PasswordWorkCapacityError extends Error {
  constructor() {
    super("Password verification capacity is temporarily exhausted.");
    this.name = "PasswordWorkCapacityError";
  }
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string) {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be between 1 and ${MAX_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, keyLength)) as Buffer;
  return `${passwordVersion}$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const [version, salt, hash] = storedHash.split("$");
  if (version !== passwordVersion || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64url");
  const actual = await withPasswordVerificationSlot(
    () => scrypt(password, salt, expected.length) as Promise<Buffer>,
  );

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function withPasswordVerificationSlot<T>(work: () => Promise<T>) {
  await acquirePasswordVerificationSlot();
  try {
    return await work();
  } finally {
    releasePasswordVerificationSlot();
  }
}

async function acquirePasswordVerificationSlot() {
  if (activePasswordVerifications < passwordVerifyConcurrency) {
    activePasswordVerifications += 1;
    return;
  }
  if (passwordVerificationWaiters.length >= passwordVerifyQueueLimit) {
    throw new PasswordWorkCapacityError();
  }
  await new Promise<void>((resolve) => {
    passwordVerificationWaiters.push(resolve);
  });
}

function releasePasswordVerificationSlot() {
  const next = passwordVerificationWaiters.shift();
  if (next) {
    next();
    return;
  }
  activePasswordVerifications = Math.max(0, activePasswordVerifications - 1);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, min), max)
    : fallback;
}
