/**
 * 本地替换音频的存放处：用 IndexedDB 存 Blob。
 * Web 与 Tauri(WebView2/WKWebView) 都支持 IndexedDB，因此多端共用一套实现，
 * 且刷新 / 重启后依然存在（比 localStorage 的 5MB 限制靠谱得多）。
 */

const DB_NAME = "aurora-audio";
const STORE = "files";
const DB_VERSION = 1;

export interface LocalAudioRecord {
  blob: Blob;
  name: string;
  size: number;
  type: string;
  addedAt: number;
}

export type PutAudioResult = "persisted" | "session";

/** IndexedDB 不可用时的内存兜底：本次会话内依然可用（刷新后失效） */
const memoryAudio = new Map<number, LocalAudioRecord>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** IndexedDB 在个别环境（隐私模式 / 无存储权限 / 无头浏览器）可能既不成功也不失败，必须有超时兜底 */
const OPEN_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), ms);
    void p.then((v) => {
      clearTimeout(timer);
      done(v);
    });
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = withTimeout(
    new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") {
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }),
    null,
    OPEN_TIMEOUT_MS,
  );
  return dbPromise;
}

/** 包一层事务超时，避免异常环境把播放流程卡死 */
function runTx<T>(db: IDBDatabase, fn: (store: IDBObjectStore) => IDBRequest | null, onDone: () => T, fallback: T): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const req = fn(tx.objectStore(STORE));
        void req;
        tx.oncomplete = () => resolve(onDone());
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    }),
    fallback,
    OPEN_TIMEOUT_MS,
  );
}

function runRead<T>(db: IDBDatabase, fn: (store: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve((req.result as T) ?? fallback);
        req.onerror = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    }),
    fallback,
    OPEN_TIMEOUT_MS,
  );
}

/**
 * 保存某首歌替换用的音频。
 * @returns persisted = 已持久化；session = 存储不可用，仅本次会话有效
 */
export async function putLocalAudio(songId: number, file: File): Promise<PutAudioResult> {
  return putLocalAudioBlob(songId, file, file.name, file.type);
}

/**
 * 同上，但接受任意 Blob + 文件名 —— 导入 ZIP 时音频是"从包里解出来的字节"，
 * 没有现成的 File，用这个入口写进同一个 IndexedDB 存储。
 */
export async function putLocalAudioBlob(
  songId: number,
  blob: Blob,
  name: string,
  type?: string,
): Promise<PutAudioResult> {
  const record: LocalAudioRecord = {
    blob,
    name,
    size: blob.size,
    type: type || blob.type || "",
    addedAt: Date.now(),
  };
  // 先放内存，保证本次会话一定能用
  memoryAudio.set(songId, record);

  const db = await openDb();
  if (!db) return "session";
  const ok = await runTx(
    db,
    (store) => store.put(record, songId),
    () => true,
    false,
  );
  return ok ? "persisted" : "session";
}

export async function getLocalAudio(songId: number): Promise<LocalAudioRecord | null> {
  const db = await openDb();
  if (db) {
    const rec = await runRead<LocalAudioRecord | null>(db, (store) => store.get(songId), null);
    if (rec) return rec;
  }
  return memoryAudio.get(songId) ?? null;
}

export async function deleteLocalAudio(songId: number): Promise<void> {
  memoryAudio.delete(songId);
  const db = await openDb();
  if (!db) return;
  await runTx(
    db,
    (store) => store.delete(songId),
    () => undefined,
    undefined,
  );
}

/** 列出已持久化的本地音频 id（用于清理失效的替换标记） */
export async function listLocalAudioIds(): Promise<number[]> {
  const db = await openDb();
  if (!db) return [];
  return withTimeout(
    new Promise<number[]>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(Number).filter((n) => !Number.isNaN(n)));
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    }),
    [],
    OPEN_TIMEOUT_MS,
  );
}

/* ---------------- object URL 缓存 ---------------- */

const urlCache = new Map<number, string>();

/** 取这首歌本地替换音频的可播放地址（无替换返回 null） */
export async function getLocalAudioUrl(songId: number): Promise<string | null> {
  const cached = urlCache.get(songId);
  if (cached) return cached;
  const rec = await getLocalAudio(songId);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(songId, url);
  return url;
}

/** 作废某首歌的 object URL（替换 / 还原后调用） */
export function invalidateLocalAudioUrl(songId: number): void {
  const url = urlCache.get(songId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(songId);
  }
}
