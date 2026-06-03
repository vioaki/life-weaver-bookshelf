import type { AppConfig, BookRecord } from "./types";

const DB_NAME = "life_weaver_bookshelf";
const DB_VERSION = 1;
const BOOK_STORE = "books";

export const STORAGE_KEYS = {
  cfg: "lw_cfg",
  activeBook: "lw_active_book_id",
  legacySave: "lw_save",
  migration: "lw_bookshelf_migrated_v1",
};

const DEFAULT_CONFIG: AppConfig = {
  url: "https://api.openai.com/v1",
  key: "",
  model: "gpt-4.1-mini",
  temperature: 1,
  style: "跌宕传奇",
  custom: "",
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        const store = db.createObjectStore(BOOK_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
        store.createIndex("status", "status");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOK_STORE, mode);
    const store = tx.objectStore(BOOK_STORE);
    const req = fn(store);
    let result: T | undefined;
    if (req) {
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listBooks(): Promise<BookRecord[]> {
  const books = (await withStore<BookRecord[]>("readonly", (store) => store.getAll())) || [];
  return books.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  return withStore<BookRecord>("readonly", (store) => store.get(id));
}

export async function saveBook(book: BookRecord): Promise<void> {
  await withStore("readwrite", (store) => {
    store.put(book);
  });
}

export async function deleteBook(id: string): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(id);
  });
}

export function loadConfig(): AppConfig {
  const saved = safeParse<Partial<AppConfig>>(localStorage.getItem(STORAGE_KEYS.cfg)) || {};
  return { ...DEFAULT_CONFIG, ...saved, key: saved?.key || "" };
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(STORAGE_KEYS.cfg, JSON.stringify(cfg));
}

export function getActiveBookId(): string {
  return localStorage.getItem(STORAGE_KEYS.activeBook) || "";
}

export function setActiveBookId(id: string): void {
  localStorage.setItem(STORAGE_KEYS.activeBook, id);
}

export async function migrateLegacySave(): Promise<void> {
  if (localStorage.getItem(STORAGE_KEYS.migration)) return;
  const legacy = safeParse<{ G?: any; history?: any[] }>(localStorage.getItem(STORAGE_KEYS.legacySave));
  if (!legacy?.G || !Array.isArray(legacy.history) || legacy.history.length === 0) {
    localStorage.setItem(STORAGE_KEYS.migration, "1");
    return;
  }

  const now = Date.now();
  const state = legacy.G;
  const book: BookRecord = {
    id: crypto.randomUUID(),
    title: state.name ? `《${state.name}传》` : "旧卷一",
    createdAt: now,
    updatedAt: now,
    status: state.dead ? "finished" : "ongoing",
    protagonist: state.name || "无名者",
    world: state.world || "未名世界",
    avatar: state.avatar || "卷",
    coverStyle: makeCoverStyle(state.world || "", state.avatar || "卷"),
    pages: [],
    history: legacy.history,
    state,
    finale: state.death || null,
    summaryLine: makeSummaryLine(state),
  };
  await saveBook(book);
  setActiveBookId(book.id);
  localStorage.setItem(STORAGE_KEYS.migration, "1");
}

export function makeCoverStyle(world: string, avatar: string): BookRecord["coverStyle"] {
  const seed = `${world}${avatar}`;
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const seals = ["#9e2b25", "#8a2722", "#7f3b20", "#3f6b4a", "#6b4b8a"];
  const papers = ["#e9dcbf", "#e3d4b2", "#ead7b0", "#dbc49a", "#efe0bd"];
  return { seal: seals[hash % seals.length], paper: papers[(hash >> 3) % papers.length] };
}

export function makeSummaryLine(state: any): string {
  const world = state?.world || "未名世界";
  const age = state?.age != null ? `${state.age}岁` : "年岁未详";
  const status = state?.dead ? "终章已成" : "仍在续写";
  return `${world} · ${age} · ${status}`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
