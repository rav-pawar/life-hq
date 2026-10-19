// Tiny IndexedDB wrapper shared by the page (via <script>) and the service worker (via importScripts).
// Stores: alerts (push history), meta (misc + the device key pair: non-extractable private CryptoKey), local (on-device taps: done / charged / low ...).
(function (g) {
  const DB_NAME = 'life-hq';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('alerts')) {
          const s = db.createObjectStore('alerts', { keyPath: 'id' });
          s.createIndex('ts', 'ts');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('local')) db.createObjectStore('local');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function reqP(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }

  const HQDB = {
    // Insert or merge an alert. Keeps an existing status (e.g. 'done') if the same id arrives again.
    putAlert(alert) {
      return tx('alerts', 'readwrite', async s => {
        const existing = await reqP(s.get(alert.id));
        const rec = Object.assign({ status: 'pending' }, existing || {}, alert,
          { status: existing ? existing.status : 'pending', receivedAt: existing ? existing.receivedAt : Date.now() });
        s.put(rec);
        return rec;
      });
    },
    getAll() { return tx('alerts', 'readonly', s => reqP(s.getAll())); },
    setStatus(id, status) {
      return tx('alerts', 'readwrite', async s => {
        const rec = await reqP(s.get(id));
        if (rec) { rec.status = status; rec.statusAt = Date.now(); s.put(rec); }
        return rec;
      });
    },
    // Removes done/dismissed items, and anything (except pending urgent) older than maxAgeDays.
    clearOld(maxAgeDays) {
      const cutoff = Date.now() - (maxAgeDays || 14) * 864e5;
      return tx('alerts', 'readwrite', async s => {
        const all = await reqP(s.getAll());
        let n = 0;
        for (const a of all) {
          const pendingUrgent = a.type === 'urgent' && a.status === 'pending';
          if (!pendingUrgent && (a.status !== 'pending' || (a.ts || a.receivedAt) < cutoff)) { s.delete(a.id); n++; }
        }
        return n;
      });
    },
    getMeta(key) { return tx('meta', 'readonly', s => reqP(s.get(key))); },
    setMeta(key, val) { return tx('meta', 'readwrite', s => { s.put(val, key); }); },
    delMeta(key) { return tx('meta', 'readwrite', s => { s.delete(key); }); },

    // On-device state, keyed like 'maint:<taskId>', 'charge:<deviceId>', 'supply:<id>', 'card:<id>'.
    getLocalAll() {
      return tx('local', 'readonly', async s => {
        const [keys, vals] = await Promise.all([reqP(s.getAllKeys()), reqP(s.getAll())]);
        const out = {};
        keys.forEach((k, i) => { out[k] = vals[i]; });
        return out;
      });
    },
    setLocal(key, val) { return tx('local', 'readwrite', s => { s.put(val, key); }); },
    delLocal(key) { return tx('local', 'readwrite', s => { s.delete(key); }); }
  };

  g.HQDB = HQDB;
})(self);
