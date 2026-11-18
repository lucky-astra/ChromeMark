const DB_NAME = "chromemark-library";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("createdAt", "createdAt");
        items.createIndex("categoryId", "categoryId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("items", mode);
    const store = tx.objectStore("items");
    let result;
    try { result = action(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function listItems() {
  return withStore("readonly", store => store.getAll());
}

export async function getItem(id) {
  return withStore("readonly", store => store.get(id));
}

export async function putItem(item) {
  return withStore("readwrite", store => store.put(item));
}

export async function removeItem(id) {
  return withStore("readwrite", store => store.delete(id));
}

export async function replaceItems(items) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    store.clear();
    for (const item of items) store.put(item);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function saveImageBlob(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "follow" });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.startsWith("image/")) return null;
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024) return null;
    return { blob, mimeType: blob.type || type, fileSize: blob.size };
  } catch {
    return null;
  }
}

export function normalizeItem(input, oldItem = null) {
  const now = new Date().toISOString();
  return {
    id: oldItem?.id || input.id || crypto.randomUUID(),
    type: input.type === "image" ? "image" : "text",
    content: String(input.content || "").trim(),
    categoryId: input.categoryId || "inbox",
    tags: Array.isArray(input.tags) ? input.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
    note: String(input.note || "").trim(),
    sourceTitle: String(input.sourceTitle || "").trim(),
    sourceUrl: String(input.sourceUrl || "").trim(),
    sourceDomain: String(input.sourceDomain || domainFromUrl(input.sourceUrl)).trim(),
    originalUrl: String(input.originalUrl || "").trim(),
    imageBlob: input.imageBlob instanceof Blob ? input.imageBlob : oldItem?.imageBlob instanceof Blob ? oldItem.imageBlob : null,
    imageMimeType: input.imageMimeType || oldItem?.imageMimeType || "",
    imageFileSize: input.imageFileSize || oldItem?.imageFileSize || 0,
    favorite: Boolean(input.favorite ?? oldItem?.favorite),
    copyCount: Number(input.copyCount ?? oldItem?.copyCount ?? 0),
    lastCopiedAt: input.lastCopiedAt || oldItem?.lastCopiedAt || null,
    createdAt: oldItem?.createdAt || input.createdAt || now,
    updatedAt: now
  };
}

function domainFromUrl(value = "") {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
}
