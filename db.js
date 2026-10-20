// Minimal IndexedDB wrapper: stores "items", "outfits" and "trips", keyed by id.

const DB_NAME = 'wardrobe';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['items', 'outfits', 'trips']) { // v2 added trips
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const getAll = async name => wrap((await store(name)).getAll());
export const get = async (name, id) => wrap((await store(name)).get(id));
export const put = async (name, value) => wrap((await store(name, 'readwrite')).put(value));
export const del = async (name, id) => wrap((await store(name, 'readwrite')).delete(id));
export const clear = async name => wrap((await store(name, 'readwrite')).clear());

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
