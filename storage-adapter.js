// @ts-check
"use strict";

export class StorageAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "StorageAdapterError";
    this.code = code;
    this.cause = options.cause;
    this.recoveredInMemory = options.recoveredInMemory === true;
  }
}

export function createMemoryStorage(seed = {}) {
  const values = new Map(
    Object.entries(seed).map(([key, value]) => [key, String(value)]),
  );
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

export function createStorageAdapter(options = {}) {
  const memory = options.memoryStorage || createMemoryStorage();
  const dirtyMemoryKeys = new Set();

  function persistentStorage() {
    if (options.storage) return options.storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  return {
    readJson(key, fallback, settings = {}) {
      const raw = readRaw(key);
      if (raw == null) return clone(fallback);
      try {
        const parsed = JSON.parse(raw);
        const isEnvelope =
          parsed &&
          typeof parsed === "object" &&
          Object.hasOwn(parsed, "schemaVersion") &&
          Object.hasOwn(parsed, "value");
        const storedVersion = isEnvelope ? Number(parsed.schemaVersion) : 0;
        const value = isEnvelope ? parsed.value : parsed;
        return settings.migrate
          ? settings.migrate(
              clone(value),
              storedVersion,
              Number(settings.version || storedVersion),
            )
          : value;
      } catch {
        removeRaw(key);
        return clone(fallback);
      }
    },

    writeJson(key, value, settings = {}) {
      const envelope = JSON.stringify({
        schemaVersion: Number(settings.version || 1),
        value,
      });
      const store = persistentStorage();
      if (!store) {
        memory.setItem(key, envelope);
        dirtyMemoryKeys.add(key);
        if (typeof window === "undefined") return value;
        throw new StorageAdapterError(
          "STORAGE_UNAVAILABLE",
          "Persistent browser storage is unavailable. Changes are kept only for this session.",
          { recoveredInMemory: true },
        );
      }
      try {
        store.setItem(key, envelope);
        dirtyMemoryKeys.delete(key);
        memory.removeItem(key);
        return value;
      } catch (cause) {
        memory.setItem(key, envelope);
        dirtyMemoryKeys.add(key);
        const quota =
          cause?.name === "QuotaExceededError" || cause?.code === 22;
        throw new StorageAdapterError(
          quota ? "STORAGE_QUOTA_EXCEEDED" : "STORAGE_WRITE_FAILED",
          quota
            ? "Browser storage is full. The change is kept only for this session."
            : "The browser could not save this change. It is kept only for this session.",
          { cause, recoveredInMemory: true },
        );
      }
    },

    remove(key) {
      removeRaw(key);
    },

    removeMany(keys) {
      for (const key of keys) removeRaw(key);
    },

    isPersistentAvailable() {
      return Boolean(persistentStorage());
    },
  };

  function readRaw(key) {
    if (dirtyMemoryKeys.has(key)) return memory.getItem(key);
    const store = persistentStorage();
    try {
      return store?.getItem(key) ?? memory.getItem(key);
    } catch {
      return memory.getItem(key);
    }
  }

  function removeRaw(key) {
    dirtyMemoryKeys.delete(key);
    memory.removeItem(key);
    try {
      persistentStorage()?.removeItem(key);
    } catch {
      // Removing persistent data is best-effort; the in-memory copy is gone.
    }
  }
}

export const appStorage = createStorageAdapter();

export function reportStorageError(error) {
  if (!(error instanceof StorageAdapterError)) return false;
  if (typeof document !== "undefined" && typeof CustomEvent !== "undefined") {
    document.dispatchEvent(
      new CustomEvent("pathforall-storage-error", { detail: error }),
    );
  }
  return true;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
