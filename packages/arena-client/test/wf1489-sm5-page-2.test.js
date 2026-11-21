// wf1489 sm5 page-2: a wallet entry an older page kept unpacked (arena.walletdb.<fed16>.<sec16>.<raw key>) and the same key written again by the
// wallet (put: the packed key) are two rows of one key; packWallets later moves the OLD row onto the packed key and writes over the newer value.
// Reached when a pass of packWallets stops on a full browser (a long value's blob refused: it throws and leaves the rest unpacked) and the wallet
// then writes on; the next pass (the 8 s tidy, "Fix it", any refused write) rolls the wallet's entry back to what the older page wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletStoreFor, packWallets } from '../src/page-lock.js';

function quotaStorage() {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const S = {
    map, cap: Infinity,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const s = String(v);
      if (used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + s.length > S.cap) { const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, s);
    },
    removeItem: (k) => { map.delete(k); },
  };
  return { S, used };
}

test('a wallet entry written after a packing pass stopped is not rolled back by the next pass', () => {
  const { S: L, used } = quotaStorage();
  const fed = new Uint8Array(32).fill(7), secret = new Uint8Array(32).fill(9);
  const s = walletStoreFor(L, fed, secret);
  const prefix = 'arena.walletdb.' + '07'.repeat(8) + '.';
  // the wallet's own prefix, as walletStoreFor names it
  s.put('aa', 'bb'); const own = [...L.map.keys()].find((k) => k.startsWith(prefix)); s.remove('aa');
  const base = own.slice(0, own.lastIndexOf('.') + 1);
  // written by an older page, unpacked: a long value first, then the wallet's counter
  L.map.set(base + 'ab'.repeat(60), 'cd'.repeat(3000));
  L.map.set(base + 'c0ffee', '0001');
  // a full browser: the long value's blob is refused, the pass stops
  L.cap = used() + 100;
  assert.throws(() => packWallets(L), /quota/);
  L.cap = Infinity;
  // the wallet writes its counter on (the newer value)
  s.put('c0ffee', '0002');
  const before = new Map(JSON.parse(s.entries()));
  // the next pass (the 8 s tidy or "Fix it")
  packWallets(L);
  const after = JSON.parse(s.entries()).filter(([k]) => k === 'c0ffee');
  assert.deepEqual(after, [['c0ffee', '0002']], `the wallet's newest value stays (the open read ${before.get('c0ffee')})`);
});
