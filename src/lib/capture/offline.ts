export type OfflineCapture = {
  id: string;
  ownerSha256: string;
  title: string;
  content: string;
  tags: string;
  file?: File;
  createdAt: string;
};

export type OfflineCaptureOwner = {
  tenantId: string;
  actorId: string;
};

const databaseName = "omni-private-outbox";
const databaseVersion = 2;
const storeName = "captures";
const ownerIndexName = "ownerSha256";
const acceptedOfflineCaptureId = /^capture-offline-[A-Za-z0-9_-]{24}$/;

export async function queueOfflineCapture(
  owner: OfflineCaptureOwner,
  input: Omit<OfflineCapture, "id" | "ownerSha256" | "createdAt">,
) {
  const capture: OfflineCapture = {
    ...input,
    id: offlineCaptureId(),
    ownerSha256: await offlineCaptureOwnerSha256(owner),
    createdAt: new Date().toISOString(),
  };
  const database = await openDatabase();
  try {
    await transactionPromise(database, "readwrite", (store) => store.put(capture));
  } finally {
    database.close();
  }
  return capture;
}

export async function listOfflineCaptures(
  owner: OfflineCaptureOwner,
): Promise<OfflineCapture[]> {
  const ownerSha256 = await offlineCaptureOwnerSha256(owner);
  const database = await openDatabase();
  try {
    const result = await transactionPromise<OfflineCapture[]>(
      database,
      "readonly",
      (store) => store.index(ownerIndexName).getAll(ownerSha256),
    );
    return result.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt));
  } finally {
    database.close();
  }
}

/**
 * Moves records created by the former single-account outbox into the one
 * account explicitly allowed to inherit that local data. Callers must pass a
 * server-derived permission; a newly provisioned account can never opt itself
 * into the migration from browser state.
 */
export async function claimLegacyOfflineCaptures(
  owner: OfflineCaptureOwner,
  canClaimLegacyOfflineCaptures: boolean,
) {
  if (!canClaimLegacyOfflineCaptures) return 0;
  const ownerSha256 = await offlineCaptureOwnerSha256(owner);
  const database = await openDatabase();
  try {
    return await claimLegacyRecords(database, ownerSha256);
  } finally {
    database.close();
  }
}

export async function removeOfflineCapture(owner: OfflineCaptureOwner, id: string) {
  const ownerSha256 = await offlineCaptureOwnerSha256(owner);
  const database = await openDatabase();
  try {
    const capture = await transactionPromise<OfflineCapture | undefined>(
      database,
      "readonly",
      (store) => store.get(id),
    );
    if (capture?.ownerSha256 === ownerSha256) {
      await transactionPromise(database, "readwrite", (store) => store.delete(id));
    }
  } finally {
    database.close();
  }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(storeName)
        ? request.transaction?.objectStore(storeName)
        : request.result.createObjectStore(storeName, { keyPath: "id" });
      if (store && !store.indexNames.contains(ownerIndexName)) {
        store.createIndex(ownerIndexName, "ownerSha256", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Offline outbox could not be opened."));
  });
}

function claimLegacyRecords(database: IDBDatabase, ownerSha256: string) {
  return new Promise<number>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const allKeysRequest = store.getAllKeys();
    const ownedKeysRequest = store.index(ownerIndexName).getAllKeys();
    let allKeys: IDBValidKey[] | undefined;
    let ownedKeys: IDBValidKey[] | undefined;
    let migrationStarted = false;
    let claimed = 0;

    const migrateUnownedKeys = () => {
      if (migrationStarted || !allKeys || !ownedKeys) return;
      migrationStarted = true;
      const owned = new Set(
        ownedKeys.filter((key): key is string => typeof key === "string"),
      );
      for (const key of allKeys) {
        if (typeof key !== "string" || owned.has(key)) continue;
        const captureRequest = store.get(key);
        captureRequest.onsuccess = () => {
          const capture = legacyCapture(captureRequest.result);
          if (!capture || capture.ownerSha256) return;
          const nextId = acceptedOfflineCaptureId.test(capture.id)
            ? capture.id
            : offlineCaptureId();
          const migrated: OfflineCapture = {
            ...capture,
            id: nextId,
            ownerSha256,
          };
          if (nextId === capture.id) {
            store.put(migrated);
          } else {
            store.delete(key);
            // add(), rather than put(), makes an improbable generated-id collision
            // abort and roll back the whole migration instead of replacing data.
            store.add(migrated);
          }
          claimed += 1;
        };
      }
    };

    allKeysRequest.onsuccess = () => {
      allKeys = allKeysRequest.result;
      migrateUnownedKeys();
    };
    ownedKeysRequest.onsuccess = () => {
      ownedKeys = ownedKeysRequest.result;
      migrateUnownedKeys();
    };
    transaction.oncomplete = () => resolve(claimed);
    transaction.onabort = () => reject(
      transaction.error || new Error("The legacy offline outbox migration was aborted."),
    );
    transaction.onerror = () => {
      // onabort owns the rejection so the transaction remains atomic.
    };
  });
}

function legacyCapture(value: unknown): (Omit<OfflineCapture, "ownerSha256"> & {
  ownerSha256?: string;
}) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.content !== "string" ||
    typeof record.tags !== "string" ||
    typeof record.createdAt !== "string" ||
    (record.ownerSha256 !== undefined && typeof record.ownerSha256 !== "string") ||
    (record.file !== undefined && !(record.file instanceof File))
  ) {
    return undefined;
  }
  return {
    id: record.id,
    title: record.title,
    content: record.content,
    tags: record.tags,
    createdAt: record.createdAt,
    ...(record.ownerSha256 ? { ownerSha256: record.ownerSha256 } : {}),
    ...(record.file instanceof File ? { file: record.file } : {}),
  };
}

function transactionPromise<T = void>(database: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Offline outbox operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Offline outbox transaction was aborted."));
  });
}

function offlineCaptureId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  return `capture-offline-${encoded}`;
}

async function offlineCaptureOwnerSha256(owner: OfflineCaptureOwner) {
  const payload = new TextEncoder().encode(
    `asael.capture-outbox-owner:1\0${owner.tenantId}\0${owner.actorId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}
