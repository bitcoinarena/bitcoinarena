// wf1489 sm5 page-1: a wallet write refused for quota right after its long value (arena.walletblob.*) was written: the storage-full handler
// the page wires (ARENA_TIDY_STORAGE -> packWallets) removes that blob as "named by no wallet" - the entry naming it is not written yet -
// and the retried entry write then succeeds, pointing at a blob that is gone. The wallet database no longer opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletStoreFor, packWallets, onStorageFull } from '../src/page-lock.js';

function quotaStorage(capacity) {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map, used, cap: { n: capacity },
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const s = String(v);
      const after = used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + s.length;
      if (after > this.cap.n) { const e = new Error('Setting the value exceeded the quota'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, s);
    },
    removeItem: (k) => { map.delete(k); },
  };
}

test('a wallet entry whose long value was written just before the browser filled still opens after the storage-full handler ran', () => {
  const L = quotaStorage(1e9);
  const fed = new Uint8Array(32).fill(7), secret = new Uint8Array(32).fill(9);
  const s = walletStoreFor(L, fed, secret);
  s.put('aa', 'bb');                                   // a wallet already here
  const longValue = 'cd'.repeat(3000);                 // a federation config sized value: kept once as a blob
  // the browser has room for the blob, and not for the short entry after it: the cap is set the moment the blob is in
  const set = L.setItem.bind(L);
  L.setItem = (k, v) => { set(k, v); if (k.startsWith('arena.walletblob.') && L.cap.n > 1e8) L.cap.n = L.used() + 10; };
  // what the page does on a refused write (index.html: onStorageFull -> ARENA_TIDY_STORAGE -> packWallets first)
  onStorageFull(() => { packWallets(L); });
  // kanban #1977: 10 characters are left and nothing else can be freed, so the entry cannot fit honestly - before the fix it "fit" only because the
  // sweep removed its own blob. The write is now refused for quota (said through onStorageRefused) and the database still opens.
  let refused = null;
  try {
    s.put('11', longValue);
  } catch (e) { refused = e; } finally { onStorageFull(null); }
  if (refused) assert.match(`${refused.name} ${refused.message}`, /quota/i);
  let entries;
  assert.doesNotThrow(() => { entries = JSON.parse(s.entries()); }, 'the wallet database opens');
  assert.deepEqual(entries.sort(), (refused ? [['aa', 'bb']] : [['11', longValue], ['aa', 'bb']]).sort());
});

test('kanban #1977: the storage-full handler frees room elsewhere and spares the blob of the entry it is rescuing', () => {
  const L = quotaStorage(1e9);
  const fed = new Uint8Array(32).fill(7), secret = new Uint8Array(32).fill(9);
  const s = walletStoreFor(L, fed, secret);
  s.put('aa', 'bb');
  const prefix = [...L.map.keys()][0].replace(/[^.]*$/, '');
  L.map.set(prefix + 'ee', 'ab'.repeat(500));          // an entry from before packing: packWallets frees ~700 characters on it
  const longValue = 'cd'.repeat(3000);
  const set = L.setItem.bind(L);
  L.setItem = (k, v) => { set(k, v); if (k.startsWith('arena.walletblob.') && L.cap.n > 1e8) L.cap.n = L.used() + 10; };
  onStorageFull(() => { packWallets(L); });
  try { s.put('11', longValue); } finally { onStorageFull(null); }
  assert.ok([...L.map.keys()].some((k) => k.startsWith('arena.walletblob.')), 'the blob is kept');
  let entries;
  assert.doesNotThrow(() => { entries = JSON.parse(s.entries()); }, 'the wallet database opens');
  assert.deepEqual(entries.sort(), [['11', longValue], ['aa', 'bb'], ['ee', 'ab'.repeat(500)]].sort());
});
