import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * An encrypted backup is this 8-byte marker, a 12-byte nonce, the AES-256-GCM
 * ciphertext of the pg_dump archive, and the 16-byte tag. The tag also covers
 * the marker and the nonce.
 */
const BACKUP_MAGIC = Buffer.from("ASAELBK1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = BACKUP_MAGIC.length + NONCE_BYTES;

export const BACKUP_ENCRYPTION_ALGORITHM = "aes-256-gcm";

/** Reads OMNIAGENT_BACKUP_ENCRYPTION_KEY: 32 random bytes in base64. */
export function parseBackupEncryptionKey(value) {
  const text = String(value ?? "").trim();
  const key = /^[A-Za-z0-9+/_-]{43}=?$/.test(text)
    ? Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64")
    : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error(
      "OMNIAGENT_BACKUP_ENCRYPTION_KEY must be 32 random bytes in base64. " +
        "Create one with `openssl rand -base64 32` and keep it apart from the backups.",
    );
  }
  return key;
}

/** Names a key without revealing it, so a drill can report a wrong key. */
export function backupEncryptionKeyId(key) {
  return createHash("sha256")
    .update("asael-backup-key-id\0")
    .update(key)
    .digest("hex")
    .slice(0, 16);
}

/** Encrypts a pg_dump archive as it streams through. */
export function createBackupEncryptionStream(key) {
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([BACKUP_MAGIC, nonce]);
  const cipher = createCipheriv(BACKUP_ENCRYPTION_ALGORITHM, key, nonce);
  cipher.setAAD(header);
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        callback(null, cipher.update(chunk));
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        callback(null, Buffer.concat([cipher.final(), cipher.getAuthTag()]));
      } catch (error) {
        callback(error);
      }
    },
  });
  stream.push(header);
  return stream;
}

/**
 * Decrypts an encrypted backup into `output`, which it creates owner-only.
 * The output is removed again unless the tag shows the whole archive is the
 * one encrypted with `key`.
 */
export async function decryptBackupFile(input, output, key) {
  const { size } = await stat(input);
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  if (size > HEADER_BYTES + TAG_BYTES) {
    const handle = await open(input, "r");
    try {
      await handle.read(header, 0, HEADER_BYTES, 0);
      await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
      await handle.close();
    }
  }
  if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("The backup is not an encrypted Asael backup.");
  }
  const decipher = createDecipheriv(
    BACKUP_ENCRYPTION_ALGORITHM,
    key,
    header.subarray(BACKUP_MAGIC.length),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let authenticated = true;
  decipher.once("error", () => {
    authenticated = false;
  });
  try {
    await pipeline(
      createReadStream(input, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw error;
    }
    await rm(output, { force: true });
    throw authenticated
      ? error
      : new Error(
          "The backup failed authentication: the file was changed, or the key is not the one it was encrypted with.",
        );
  }
}

/**
 * Refuses a backup path inside a git checkout, where a dump could be
 * committed, synced, or packaged with the source.
 */
export async function assertOutsideCheckout(file, variable) {
  let directory = path.dirname(path.resolve(file));
  // Resolve the nearest directory that exists, so a symlink cannot hide a
  // checkout; the parts still to be created cannot hold one.
  for (;;) {
    try {
      directory = await realpath(directory);
      break;
    } catch (error) {
      const parent = path.dirname(directory);
      if (error?.code !== "ENOENT" || parent === directory) {
        throw error;
      }
      directory = parent;
    }
  }
  for (let current = directory; ; current = path.dirname(current)) {
    if (await pathExists(path.join(current, ".git"))) {
      throw new Error(
        `${variable} must be outside a git checkout, and ${current} is one. ` +
          "Keep backups in a private directory such as ~/.asael/backups.",
      );
    }
    if (path.dirname(current) === current) {
      return;
    }
  }
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/**
 * A JSON expression listing who may use each Asael table, sequence, view,
 * column, and function, apart from its owner, whom a restore replaces.
 * MAINTAIN is left out: a GRANT ALL dumped from an older server gains it on a
 * newer one.
 */
export const GRANT_INVENTORY_JSON = `(
  WITH objects AS (
    SELECT
      CASE class.relkind
        WHEN 'S' THEN 'sequence '
        WHEN 'v' THEN 'view '
        WHEN 'm' THEN 'materialized view '
        ELSE 'table '
      END || class.relname AS object,
      class.relowner AS owner,
      COALESCE(class.relacl, acldefault(
        CASE WHEN class.relkind = 'S' THEN 's' ELSE 'r' END::"char",
        class.relowner
      )) AS acl
    FROM pg_class class
    WHERE class.relnamespace = 'public'::regnamespace
      AND class.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND class.relname LIKE 'omni_%'
    UNION ALL
    SELECT
      'column ' || class.relname || '.' || attribute.attname,
      class.relowner,
      attribute.attacl
    FROM pg_attribute attribute
    JOIN pg_class class ON class.oid = attribute.attrelid
    WHERE class.relnamespace = 'public'::regnamespace
      AND class.relname LIKE 'omni_%'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
    UNION ALL
    SELECT
      'function ' || format(
        '%I(%s)',
        proc.proname,
        pg_get_function_identity_arguments(proc.oid)
      ),
      proc.proowner,
      COALESCE(proc.proacl, acldefault('f', proc.proowner))
    FROM pg_proc proc
    WHERE proc.pronamespace = 'public'::regnamespace
      AND proc.proname LIKE 'omni_%'
  ), grants AS (
    SELECT
      objects.object,
      CASE
        WHEN item.grantee = 0 THEN 'PUBLIC'
        ELSE pg_get_userbyid(item.grantee)::text
      END AS grantee,
      string_agg(
        item.privilege_type ||
          CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END,
        ', ' ORDER BY item.privilege_type COLLATE "C"
      ) AS privileges
    FROM objects
    CROSS JOIN LATERAL aclexplode(objects.acl) item
    WHERE item.grantee <> objects.owner
      AND item.privilege_type <> 'MAINTAIN'
    GROUP BY objects.object, item.grantee
  )
  SELECT COALESCE(
    json_agg(json_build_object(
      'object', object,
      'grantee', grantee,
      'privileges', privileges
    )),
    '[]'::json
  )
  FROM grants
)`;

/**
 * A JSON expression naming every role the dump's grants and default
 * privileges in the public schema refer to; a restore fails without them.
 */
export const GRANT_ROLES_JSON = `(
  SELECT COALESCE(json_agg(DISTINCT role_name), '[]'::json)
  FROM (
    SELECT pg_get_userbyid(item.grantee)::text AS role_name
    FROM (
      SELECT relacl AS acl, relowner AS owner
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relacl IS NOT NULL
      UNION ALL
      SELECT attribute.attacl, class.relowner
      FROM pg_attribute attribute
      JOIN pg_class class ON class.oid = attribute.attrelid
      WHERE class.relnamespace = 'public'::regnamespace
        AND attribute.attacl IS NOT NULL
      UNION ALL
      SELECT proacl, proowner
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proacl IS NOT NULL
      UNION ALL
      SELECT typacl, typowner
      FROM pg_type
      WHERE typnamespace = 'public'::regnamespace AND typacl IS NOT NULL
      UNION ALL
      SELECT nspacl, nspowner
      FROM pg_namespace
      WHERE oid = 'public'::regnamespace AND nspacl IS NOT NULL
      UNION ALL
      SELECT defaclacl, 0::oid
      FROM pg_default_acl
      WHERE defaclnamespace = 'public'::regnamespace
    ) acls
    CROSS JOIN LATERAL aclexplode(acls.acl) item
    WHERE item.grantee <> 0
      AND item.grantee <> acls.owner
    UNION
    SELECT pg_get_userbyid(defaclrole)::text
    FROM pg_default_acl
    WHERE defaclnamespace = 'public'::regnamespace
  ) names
)`;

export function isGrantInventory(value) {
  return (
    Array.isArray(value) &&
    value.every((grant) =>
      ["object", "grantee", "privileges"].every(
        (field) => typeof grant?.[field] === "string" && grant[field] !== "",
      ),
    )
  );
}

export function isRoleNameList(value) {
  return (
    Array.isArray(value) &&
    value.every((role) => typeof role === "string" && /^[^\0]{1,63}$/.test(role))
  );
}

/** What a restored database's grants lack, and hold beyond, the backup's. */
export function grantDifferences(expected, actual) {
  const describe = (grant) =>
    `${grant.object} to ${grant.grantee}: ${grant.privileges}`;
  const expectedGrants = new Set(expected.map(describe));
  const actualGrants = new Set(actual.map(describe));
  return {
    missing: [...expectedGrants].filter((grant) => !actualGrants.has(grant)).sort(),
    unexpected: [...actualGrants]
      .filter((grant) => !expectedGrants.has(grant))
      .sort(),
  };
}
