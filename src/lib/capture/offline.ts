export type OfflineCapture = {
  id: string;
  title: string;
  content: string;
  tags: string;
  file?: File;
  createdAt: string;
};

const databaseName = "omni-private-outbox";
const storeName = "captures";

export async function queueOfflineCapture(input: Omit<OfflineCapture, "id" | "createdAt">) {
  const capture: OfflineCapture = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const database = await openDatabase();
  await transactionPromise(database, "readwrite", (store) => store.put(capture));
  database.close();
  return capture;
}

export async function listOfflineCaptures(): Promise<OfflineCapture[]> {
  const database = await openDatabase();
  const result = await transactionPromise<OfflineCapture[]>(database, "readonly", (store) => store.getAll());
  database.close();
  return result.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function removeOfflineCapture(id: string) {
  const database = await openDatabase();
  await transactionPromise(database, "readwrite", (store) => store.delete(id));
  database.close();
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Offline outbox could not be opened."));
  });
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
