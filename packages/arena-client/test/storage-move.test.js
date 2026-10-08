// THE ONE-TIME MOVE FROM blwp.* TO arena.* (kanban #207). The page's keys were renamed from blwp.* to arena.*; a browser
// that played before keeps its seed, its kept phrases, its vault and its wallet only if they move before anything reads
// them. This runs the very script the page ships (index.html, <script id="arena-storage-move">, the first script there)
// against a browser filled the old way, then reads that browser back through the client's own readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tabSeed } from '../src/join.js';
import { tabWallet } from '../src/nwc.js';
import { walletStoreFor, lockStoreFor } from '../src/page-lock.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const MOVE = /<script id="arena-storage-move">([\s\S]*?)<\/script>/.exec(PAGE);

const mem = (full = () => false) => { const m = new Map(); return { get length() { return m.size; },
  key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => { if (full(k)) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
  removeItem: (k) => m.delete(k), m }; };
const runMove = (localStorage, sessionStorage) =>
  vm.runInNewContext(MOVE[1], { window: { localStorage, sessionStorage } });

const SEED = '5c'.repeat(32);
const FED = Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'));
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ROUND = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const NWC = 'nostr+walletconnect://' + 'cd'.repeat(32) + '?relay=wss%3A%2F%2Frelay.example&secret=' + 'ef'.repeat(32);

// The keys a wallet and a stake lock write, made by the client's own stores, then put back under the old prefix.
function oldKeys(make) {
  const staged = mem(); make(staged);
  return [...staged.m].map(([k, v]) => [k.replace(/^arena\./, 'blwp.'), v]);
}
const WALLET = oldKeys((s) => { const w = walletStoreFor(s, FED, SECRET); w.put('notes', '{"n":3}'); w.put('db.7', 'x'); });
const LOCK = oldKeys((s) => lockStoreFor(s, ROUND, SECRET).put('lock', '{"stake":900000}'));

// A browser as the page before #207 left it.
function oldBrowser() {
  const local = mem(), session = mem();
  session.setItem('blwp.player.seed', SEED); session.setItem('blwp.player.seed.from', 'minted'); session.setItem('blwp.tab.id', 'tab-1');
  session.setItem('blwp.wallet', NWC);
  session.setItem('blwp.session.key.' + '01'.repeat(32), '{"k":"pkcs8"}');   // Unity's (blwp.jslib)
  session.setItem('blwp.cargo.' + '01'.repeat(32), '[1,2]');                   // Unity's (blwp.jslib)
  local.setItem('blwp.seeds', JSON.stringify([{ hex: SEED, from: 'minted', at: 1 }]));
  local.setItem('blwp.vault', '1');
  local.setItem('blwp.collect.' + '02'.repeat(8), '{"owed":900000}');
  local.setItem('blwp.lock.saved.' + '03'.repeat(32) + '.' + '04'.repeat(8), '{"txid":"aa"}');
  for (const [k, v] of [...WALLET, ...LOCK]) local.setItem(k, v);
  local.setItem('other.site.key', 'kept as it is');
  return { local, session };
}

test('the move is the first script on the page, before anything reads a key', () => {
  assert.ok(MOVE, 'index.html has no <script id="arena-storage-move">');
  const first = PAGE.indexOf('<script');
  assert.equal(first, PAGE.indexOf('<script id="arena-storage-move">'), 'another script runs before the move');
});

test('an old browser keeps its seed, its kept phrases, its vault and its wallet under arena.*', () => {
  const { local, session } = oldBrowser();
  const before = { local: new Map(local.m), session: new Map(session.m) };
  runMove(local, session);

  // the seed: the client reads the same one, and mints none
  const seed = tabSeed({ storage: session, random: () => { throw new Error('a new seed was minted'); } });
  assert.equal(Buffer.from(seed).toString('hex'), SEED);
  assert.equal(session.getItem('arena.player.seed.from'), 'minted');
  assert.deepEqual(JSON.parse(local.getItem('arena.seeds')), [{ hex: SEED, from: 'minted', at: 1 }]);
  // the vault
  assert.equal(local.getItem('arena.vault'), '1');
  assert.equal(local.getItem('arena.collect.' + '02'.repeat(8)), '{"owed":900000}');
  assert.equal(local.getItem('arena.lock.saved.' + '03'.repeat(32) + '.' + '04'.repeat(8)), '{"txid":"aa"}');
  // the wallet: the player wallet's store and the stake lock's store read back what was kept
  assert.deepEqual(JSON.parse(walletStoreFor(local, FED, SECRET).entries()), [['notes', '{"n":3}'], ['db.7', 'x']]);
  assert.deepEqual(JSON.parse(lockStoreFor(local, ROUND, SECRET).entries()), [['lock', '{"stake":900000}']]);
  assert.equal(tabWallet({ storage: session }).connected, true, 'the connected wallet was lost');
  // every value moved byte for byte, under arena. + the same rest
  for (const [where, store] of [['local', local], ['session', session]])
    for (const [k, v] of before[where])
      if (k.startsWith('blwp.') && !/^blwp\.(session\.key|cargo)\./.test(k)) {
        assert.equal(store.getItem('arena.' + k.slice(5)), v, `${k} did not move`);
        assert.equal(store.getItem(k), null, `${k} was left behind`);
      }
  // Unity's keys stay where blwp.jslib reads them; a key not ours is not touched
  assert.equal(session.getItem('blwp.session.key.' + '01'.repeat(32)), '{"k":"pkcs8"}');
  assert.equal(session.getItem('blwp.cargo.' + '01'.repeat(32)), '[1,2]');
  assert.equal(session.getItem('arena.session.key.' + '01'.repeat(32)), null);
  assert.equal(local.getItem('other.site.key'), 'kept as it is');
});

test('a second load moves nothing: the move happens once', () => {
  const { local, session } = oldBrowser();
  runMove(local, session);
  const after = { local: [...local.m], session: [...session.m] };
  runMove(local, session);
  assert.deepEqual({ local: [...local.m], session: [...session.m] }, after);
});

test('a key already under arena.* is never overwritten, and its old copy is left, not lost', () => {
  const { local, session } = oldBrowser();
  local.setItem('arena.seeds', '[]');
  runMove(local, session);
  assert.equal(local.getItem('arena.seeds'), '[]');
  assert.equal(local.getItem('blwp.seeds'), JSON.stringify([{ hex: SEED, from: 'minted', at: 1 }]));
});

test('a full store keeps the old key: nothing is removed that was not copied', () => {
  const local = mem((k) => k === 'arena.seeds'), session = mem();
  local.setItem('blwp.seeds', '["kept"]'); local.setItem('blwp.vault', '1');
  runMove(local, session);
  assert.equal(local.getItem('blwp.seeds'), '["kept"]');
  assert.equal(local.getItem('arena.vault'), '1');
});

test('storage the browser refuses does not stop the page', () => {
  const refused = { get length() { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => vm.runInNewContext(MOVE[1], { window: {
    get localStorage() { throw new Error('SecurityError'); }, sessionStorage: refused } }));
});

// THE SEED'S BLWP-ERA WALLET IS STILL FOUND AFTER THE MOVE (kanban #209, pick (a)): the page made it under the BLWP tag
// (phase0's walletSecretFor: 40638580f186c452... for this seed and federation, measured against e7775f80's own code), its
// store's keys move to arena.walletdb.* with the same secret hash, and the sweep (index.html combineWallets) counts it.
test('a seed\'s BLWP-era wallet store moves with the browser and is found under the ancestor secret, not the Arena one', async () => {
  const { ancestorWalletSecretFor, walletSecretFor, phraseWalletEntries } = await import('../src/page-lock.js');
  const seed = new Uint8Array(32).fill(0x5c), fed = new Uint8Array(32).fill(0xab);
  const old = ancestorWalletSecretFor(seed, fed);
  assert.equal(Buffer.from(old).toString('hex').slice(0, 16), '40638580f186c452', 'not the secret the BLWP page used');
  assert.notEqual(Buffer.from(old).toString('hex'), Buffer.from(walletSecretFor(seed, fed)).toString('hex'));
  // the BLWP page's store of that wallet, with the ledger row that names its federation
  const staged = mem(); const w = walletStoreFor(staged, fed, old); w.put('notes', '{"n":5}'); w.put('db.1', 'y');
  const local = mem(), session = mem();
  for (const [k, v] of staged.m) local.setItem(k.replace(/^arena\./, 'blwp.'), v);
  local.setItem('blwp.ledger.' + 'ab'.repeat(32), '[]');
  runMove(local, session);
  const seedHex = '5c'.repeat(32), fedHex = 'ab'.repeat(32);
  assert.equal(phraseWalletEntries(local, seedHex, fedHex, { ancestor: true }), 2, 'the BLWP wallet is not found after the move');
  assert.equal(phraseWalletEntries(local, seedHex, fedHex), 0, 'the Arena wallet claims the BLWP wallet\'s entries');
  assert.deepEqual(JSON.parse(walletStoreFor(local, fed, old).entries()), [['notes', '{"n":5}'], ['db.1', 'y']]);
});
