// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1285 (audit 4 #1257 CLIENT-3): #1228 had the deposit resume read the browser's lock list once and skip another phrase whose lock was
// held - then open that phrase's wallet, wait minutes on its deposit's claim and sweep its e-cash out with no lock held. A tab that took the
// phrase meanwhile (a session restore starts two tabs together) ran its own client on the same wallet. The page's ARENA_KEEP_WALLET, run on
// stubs and on Node's own Web Locks (navigator.locks, the same API the page's tabs share): "tab B" asks for phrase P's lock while P's claim
// is waiting, the way the seed keeper does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = HTML.indexOf('      const RESUMED = new Set();');
const SRC = HTML.slice(at, HTML.indexOf('\n      };\n', at) + 9);
const Q = '51'.repeat(32), P = '50'.repeat(32), P2 = '52'.repeat(32), FED = 'fe'.repeat(32);
const lockName = (hex) => 'arena.phrase.' + hex.slice(0, 16);
const tryTake = (hex) => navigator.locks.request(lockName(hex), { ifAvailable: true }, (l) => !!l);
const held = async (hex) => ((await navigator.locks.query()).held || []).some((l) => l.name === lockName(hex));

function store(seeds) {
  const m = new Map([['arena.seeds', JSON.stringify(seeds.map((hex) => ({ hex })))]]);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function page({ seeds, duringClaim = async () => {}, claimMs = 150, holdClaimMs, claimForever = false, onOpen = async () => {} }) {
  const facts = { opened: [], swept: [], bTookDuringClaim: {}, heldAtSweep: {}, markAtSweep: {}, claimErrors: [] };
  const L = store(seeds);
  const sessionStorage = globalThis.sessionStorage = { getItem: (k) => (k === 'arena.player.seed' ? Q : null) };
  const window = { sessionStorage, ARENA_WALLETS: new Map(), ARENA_READ_BALANCE: () => {}, ARENA_PHRASES_HELD_HERE: new Set(),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_MONEY_ALERT: { credited() {}, lost() {}, settled() {} }, ...(holdClaimMs ? { ARENA_HOLD_CLAIM_MS: holdClaimMs } : {}) };
  const client = { receiveEcash: async () => ({}) };
  let resumed;
  const ARENACLIENT = { fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')), toHex: (b) => Buffer.from(b).toString('hex'),
    rememberedInvite: () => 'fed1invite', phraseWalletEntries: () => 1, ECASH_PENDING_PREFIX: 'arena.ecash.pending.',
    openPlayerWallet: async ({ seed }) => { const hex = Buffer.from(seed).toString('hex'); facts.opened.push(hex.slice(0, 2)); await onOpen(hex);
      return { hex, sendAllEcash: async () => 'ecash', awaitReceive: async () => { await duringClaim(hex, facts); if (claimForever) await new Promise(() => {}); await new Promise((r) => setTimeout(r, claimMs)); return 'claimed'; } }; },
    sendKeptEcash: async ({ wallet, storage }) => { const hex = wallet.hex; facts.swept.push(hex.slice(0, 2)); facts.heldAtSweep[hex.slice(0, 2)] = await held(hex);
      facts.markAtSweep[hex.slice(0, 2)] = !!storage.getItem('arena.seed.collecting.' + hex.slice(0, 16)); return { sent: true, msat: 1000n, rec: {} }; },
    receiveKeptEcash: async () => ({ state: 'received' }),
    // the resume of a deposit the tab's own wallet does not hold: the other wallets are asked, the one that holds it claims it
    resumeDeposits: (o) => (resumed = (async () => { const alts = await o.others(); await o.others();
      for (const a of alts) { try { await a.client.awaitReceive('op'); } catch (e) { facts.claimErrors.push({ stillWaiting: !!e.stillWaiting, why: e.message }); continue; } o.onClaimed({ amountMsat: 1000n, from: a }); } return ['claimed']; })()),
  };
  new Function('window', 'ARENACLIENT', 'vault', 'paintHistory', 'location', SRC)(window, ARENACLIENT, () => L, () => {}, { reload: () => { facts.reloaded = true; } });
  window.ARENA_KEEP_WALLET(FED, client);
  return { facts, done: async () => { await resumed; for (let i = 0; i < 20 && (await held(P) || await held(P2)); i++) await new Promise((r) => setTimeout(r, 25)); }, L };
}

test('#1285 the deposit resume holds another phrase\'s lock from its wallet\'s open to the end of its sweep; a tab that asks meanwhile is refused', async () => {
  const w = page({ seeds: [Q, P], duringClaim: async (hex, f) => { f.bTookDuringClaim[hex.slice(0, 2)] = await tryTake(hex); } });
  await w.done();
  const after = { heldAfter: await held(P), bTakesAfter: await tryTake(P), markAfter: !!w.L.getItem('arena.seed.collecting.' + P.slice(0, 16)) };
  console.log('  FACTS #1285 held:', JSON.stringify({ ...w.facts, ...after }));
  assert.equal(w.facts.bTookDuringClaim['50'], false, 'another tab took phrase P\'s lock while this tab\'s resume ran a client on P\'s wallet');
  assert.equal(w.facts.heldAtSweep['50'], true, 'P\'s e-cash was swept with no lock on P held');
  assert.deepEqual(w.facts.opened, ['50'], 'P\'s wallet is opened once, however often the resume asks for the other wallets');
  assert.equal(w.facts.markAtSweep['50'], true, 'no collecting mark: P\'s own tab would drop the phrase instead of waiting');
  assert.equal(after.heldAfter, false, 'the lock is let go once the sweep has ended');
  assert.equal(after.bTakesAfter, true);
  assert.equal(after.markAfter, false, 'the collecting mark is cleared');
});

test('#1285 a phrase another tab takes between the lock list and its open is skipped, not opened', async () => {
  // the list is read with P and P2 free; while P's wallet opens, "tab B" takes P2 (its seed keeper, for the tab's life)
  let release; const bHolds = new Promise((r) => { release = r; }); let bTook = null;
  const w = page({ seeds: [Q, P, P2], onOpen: async (hex) => { if (hex === P && bTook === null) bTook = await new Promise((ok) => {
    navigator.locks.request(lockName(P2), { ifAvailable: true }, (l) => { ok(!!l); return l ? bHolds : undefined; }); }); } });
  await w.done();
  console.log('  FACTS #1285 skipped:', JSON.stringify({ bTookP2DuringPsOpen: bTook, opened: w.facts.opened, swept: w.facts.swept }));
  release();
  assert.equal(bTook, true, 'the fixture: tab B holds P2 before its open');
  assert.ok(!w.facts.opened.includes('52'), 'a phrase another tab took after the lock list was read was opened here');
  assert.deepEqual(w.facts.swept, ['50']);
});

test('#1285 a claim that does not end lets the phrase go after the bound; resumeDeposits says waiting, not lost', async () => {
  const w = page({ seeds: [Q, P], claimForever: true, holdClaimMs: 300 });
  const t0 = Date.now(); await w.done();
  const facts = { ...w.facts, ms: Date.now() - t0, heldAfter: await held(P), bTakesAfter: await tryTake(P) };
  // and page-lock's resumeDeposits on such a wallet: no lost alert, the entry stays
  const { resumeDeposits, pendingDeposits } = await import('../src/page-lock.js');
  const s = store([]); const s2 = { ...s, key: (i) => [...s.m.keys()][i] ?? null, get length() { return s.m.size; } };
  s2.setItem('arena.deposit.pending.' + FED, JSON.stringify([{ operation: 'op9', invoice: 'lntb1x', msat: '1000' }]));
  const lost = [];
  const waiting = { label: '50505050', client: { awaitReceive: async () => { const e = new Error('the claim in wallet 50505050 did not end in 0 s while its phrase was held here'); e.stillWaiting = true; throw e; } } };
  const finals = await resumeDeposits({ client: { awaitReceive: async () => { throw new Error('Operation not found'); } }, storage: s2, federationId: FED, others: async () => [waiting], onLost: (p) => lost.push(p) });
  console.log('  FACTS #1285 bound:', JSON.stringify({ ...facts, finals, lost: lost.length, entryKept: pendingDeposits(s2, FED).length }));
  assert.equal(facts.claimErrors.length, 1); assert.equal(facts.claimErrors[0].stillWaiting, true);
  assert.equal(facts.heldAfter, false, 'the phrase stayed held while its claim did not end');
  assert.equal(facts.bTakesAfter, true);
  assert.deepEqual(facts.swept, [], 'nothing claimed, nothing swept');
  assert.match(finals[0], /^waiting \(in wallet 50505050/);
  assert.equal(lost.length, 0, 'a claim left to its own tab was reported lost');
  assert.equal(pendingDeposits(s2, FED).length, 1, 'the entry stays for the next page');
});
