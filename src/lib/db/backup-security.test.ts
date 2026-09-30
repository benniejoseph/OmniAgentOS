import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertOutsideCheckout,
  backupEncryptionKeyId,
  createBackupEncryptionStream,
  decryptBackupFile,
  grantDifferences,
  isGrantInventory,
  isRoleNameList,
  parseBackupEncryptionKey,
} from "../../../scripts/db-backup-security.mjs";

const key = parseBackupEncryptionKey(randomBytes(32).toString("base64"));
// Bytes shaped like a pg_dump custom archive, arriving in uneven pieces.
const archive = Buffer.concat([Buffer.from("PGDMP"), randomBytes(200_000)]);
const pieces = [
  archive.subarray(0, 1),
  archive.subarray(1, 70_001),
  archive.subarray(70_001),
];
const HEADER_BYTES = 8 + 12;
const TAG_BYTES = 16;
const AUTHENTICATION_FAILED =
  "The backup failed authentication: the file was changed, or the key is not the one it was encrypted with.";
const NOT_ENCRYPTED = "The backup is not an encrypted Asael backup.";

let directory = "";
let encrypted = "";
let restored = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "omni-backup-security-"));
  encrypted = path.join(directory, "backup.dump.enc");
  restored = path.join(directory, "backup.dump");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function encrypt(file: string, withKey = key) {
  await pipeline(
    Readable.from(pieces),
    createBackupEncryptionStream(withKey),
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
}

function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("backup encryption", () => {
  it("round-trips an archive without writing any of it in the clear", async () => {
    await encrypt(encrypted);

    const bytes = await readFile(encrypted);
    expect(bytes.length).toBe(HEADER_BYTES + archive.length + TAG_BYTES);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("ASAELBK1");
    expect(bytes.includes(archive.subarray(0, 32))).toBe(false);
    expect(bytes.includes(archive.subarray(100_000, 100_032))).toBe(false);

    await decryptBackupFile(encrypted, restored, key);

    expect((await readFile(restored)).equals(archive)).toBe(true);
    expect((await stat(restored)).mode & 0o777).toBe(0o600);
  });

  it("uses a fresh nonce for every backup", async () => {
    const second = path.join(directory, "second.dump.enc");
    await encrypt(encrypted);
    await encrypt(second);

    const [first, next] = [await readFile(encrypted), await readFile(second)];
    expect(first.subarray(8, HEADER_BYTES).equals(next.subarray(8, HEADER_BYTES))).toBe(
      false,
    );
    expect(first.subarray(HEADER_BYTES).equals(next.subarray(HEADER_BYTES))).toBe(false);
  });

  it("refuses a different key and leaves no output", async () => {
    await encrypt(encrypted);
    const otherKey = parseBackupEncryptionKey(randomBytes(32).toString("base64"));

    await expect(decryptBackupFile(encrypted, restored, otherKey)).rejects.toThrow(
      AUTHENTICATION_FAILED,
    );
    expect(await exists(restored)).toBe(false);
  });

  it("refuses a changed marker, nonce, ciphertext, or tag", async () => {
    await encrypt(encrypted);
    const original = await readFile(encrypted);

    for (const [offset, message] of [
      [0, NOT_ENCRYPTED],
      [8, AUTHENTICATION_FAILED],
      [HEADER_BYTES - 1, AUTHENTICATION_FAILED],
      [HEADER_BYTES + 100_000, AUTHENTICATION_FAILED],
      [original.length - 1, AUTHENTICATION_FAILED],
    ] as const) {
      const changed = Buffer.from(original);
      changed[offset] ^= 0x01;
      const file = path.join(directory, `changed-${offset}.dump.enc`);
      await writeFile(file, changed);

      await expect(decryptBackupFile(file, restored, key), String(offset)).rejects.toThrow(
        message,
      );
      expect(await exists(restored), String(offset)).toBe(false);
    }
  });

  it("refuses a truncated backup", async () => {
    await encrypt(encrypted);
    const original = await readFile(encrypted);

    for (const [length, message] of [
      [original.length - 1, AUTHENTICATION_FAILED],
      [original.length - TAG_BYTES, AUTHENTICATION_FAILED],
      [HEADER_BYTES + TAG_BYTES, NOT_ENCRYPTED],
      [8, NOT_ENCRYPTED],
      [0, NOT_ENCRYPTED],
    ] as const) {
      const file = path.join(directory, `truncated-${length}.dump.enc`);
      await writeFile(file, original.subarray(0, length));

      await expect(decryptBackupFile(file, restored, key), String(length)).rejects.toThrow(
        message,
      );
      expect(await exists(restored), String(length)).toBe(false);
    }
  });

  it("says a plaintext dump is not an encrypted backup", async () => {
    await writeFile(encrypted, archive);

    await expect(decryptBackupFile(encrypted, restored, key)).rejects.toThrow(
      NOT_ENCRYPTED,
    );
    expect(await exists(restored)).toBe(false);
  });

  it("never replaces a file already at the output", async () => {
    await encrypt(encrypted);
    await writeFile(restored, "keep");

    await expect(decryptBackupFile(encrypted, restored, key)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(restored, "utf8")).toBe("keep");
  });
});

describe("backup encryption key", () => {
  it("accepts 32 bytes in base64 or base64url", () => {
    const bytes = randomBytes(32);

    for (const value of [
      bytes.toString("base64"),
      ` ${bytes.toString("base64")}\n`,
      bytes.toString("base64url"),
    ]) {
      expect(parseBackupEncryptionKey(value).equals(bytes), value).toBe(true);
    }
  });

  it("refuses anything but 32 bytes in base64", () => {
    const stray = randomBytes(32).toString("base64");

    for (const value of [
      undefined,
      "",
      "not a key",
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      randomBytes(48).toString("hex"),
      "A".repeat(44),
      // Node's decoder skips the stray character and still finds 32 bytes.
      `${stray.slice(0, 21)}.${stray.slice(21)}`,
    ]) {
      expect(() => parseBackupEncryptionKey(value), String(value)).toThrow(
        "OMNIAGENT_BACKUP_ENCRYPTION_KEY must be 32 random bytes in base64.",
      );
    }
  });

  it("names a key by a digest, the same every time", () => {
    const id = backupEncryptionKeyId(key);

    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(backupEncryptionKeyId(Buffer.from(key))).toBe(id);
    expect(
      backupEncryptionKeyId(parseBackupEncryptionKey(randomBytes(32).toString("base64"))),
    ).not.toBe(id);
  });
});

describe("backup location", () => {
  it("refuses a path in a git checkout, including one still to be created", async () => {
    const checkout = path.join(directory, "checkout");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await mkdir(path.join(checkout, "private"));
    const worktree = path.join(directory, "worktree");
    await mkdir(worktree);
    await writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
    // A link from outside into the checkout's subdirectory.
    await symlink(path.join(checkout, "private"), path.join(directory, "link"));

    for (const file of [
      path.join(checkout, "backup.dump.enc"),
      path.join(checkout, "backups", "new", "backup.dump.enc"),
      path.join(worktree, "backup.dump.enc"),
      path.join(directory, "link", "backups", "backup.dump.enc"),
    ]) {
      await expect(
        assertOutsideCheckout(file, "OMNIAGENT_BACKUP_OUTPUT"),
        file,
      ).rejects.toThrow("OMNIAGENT_BACKUP_OUTPUT must be outside a git checkout, and ");
    }
  });

  it("accepts a private directory outside any checkout", async () => {
    await expect(
      assertOutsideCheckout(
        path.join(directory, "private", "backups", "backup.dump.enc"),
        "OMNIAGENT_BACKUP_OUTPUT",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("grant inventory", () => {
  const read = { object: "table omni_threads", grantee: "omni_runtime", privileges: "SELECT" };
  const write = {
    object: "table omni_threads",
    grantee: "omni_runtime",
    privileges: "INSERT, SELECT",
  };
  const anon = { object: "table omni_threads", grantee: "anon", privileges: "SELECT" };
  const ledger = {
    object: "table omni_schema_version",
    grantee: "omni_runtime",
    privileges: "SELECT",
  };

  it("reports the grants a restore lost or gained", () => {
    expect(grantDifferences([read, ledger], [ledger, read])).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(grantDifferences([write, ledger], [read, anon])).toEqual({
      missing: [
        "table omni_schema_version to omni_runtime: SELECT",
        "table omni_threads to omni_runtime: INSERT, SELECT",
      ],
      unexpected: [
        "table omni_threads to anon: SELECT",
        "table omni_threads to omni_runtime: SELECT",
      ],
    });
  });

  it("accepts only well-formed grants and role names", () => {
    expect(isGrantInventory([])).toBe(true);
    expect(isGrantInventory([read, anon])).toBe(true);
    for (const value of [
      undefined,
      {},
      [null],
      [{ ...read, privileges: "" }],
      [{ object: read.object, grantee: read.grantee }],
    ]) {
      expect(isGrantInventory(value), JSON.stringify(value)).toBe(false);
    }

    expect(isRoleNameList([])).toBe(true);
    expect(isRoleNameList(["omni_runtime", "anon", "r".repeat(63)])).toBe(true);
    for (const value of [undefined, "omni_runtime", [""], ["r".repeat(64)], ["a\0b"], [7]]) {
      expect(isRoleNameList(value), JSON.stringify(value)).toBe(false);
    }
  });
});
