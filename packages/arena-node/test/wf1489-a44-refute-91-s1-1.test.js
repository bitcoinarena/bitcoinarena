// #1489 a44 refute 91-s1-1 (kanban #1844 variant): A DRAWN SEAT DOWN 25 MIN AFTER THE WINDOW ENDED, BACK WHILE THE ROUND IS STILL DUE, NEVER SIGNS.
// server.js due() lists a drawn round until 30 min after its window ends, but drawn-attestor.js KEEP_MS (40 min) - in memory and in the
// store - drops the reading a minute before the window's start (window 15 min + 1 min) 24 min after the end. Three seats of one host down from
// the end to end + 25 min come back with their readings pruned at construction: no 5 of 7, the market VOID although they read it. The fixed
// daemon keeps 2 h (arena-attestor.mjs KEEP_MS).
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DrawnAttestor } from '../src/drawn-attestor.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = new Uint8Array(32).fill(0x51);
const WINDOW = { startMs: 900000n, endMs: 1800000n };
const secretOf = (i) => { const s = new Uint8Array(32); s[31] = i + 1; return s; };
const KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(secretOf(i))));
const MANIFEST = {
  gameName: 'up-down-drawn', gameDevPubkey: new Uint8Array(32).fill(9), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 900000n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: new Uint8Array(32), outcomes: ['Up', 'Down'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 2,
};
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

function net({ price = (c) => (c < 900000 ? 8000000 : 8001234) } = {}) {
  const st = { clock: 0, held: new Map(), list: [], dbs: [], dir: mkdtempSync(join(tmpdir(), 'a44r91s1-')) };
  st.make = (i) => new DrawnAttestor({
    db: (st.dbs[i] = new DatabaseSync(join(st.dir, `seat-${i}.sqlite`))),
    selfKey: KEYS[i], sign: (d) => schnorr.sign(d, secretOf(i)), verify, attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => ({ cents: price(st.clock), atMs: st.clock }), now: () => st.clock,
    hold: async (bytes) => { const s = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS }); if (s.ok) st.held.set(i, s); return s.ok; },
    fetcher: async (url) => { const j = Number(new URL(url).host.split('-')[1]); const w = st.list[j].served(ROUND); return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null }; },
  });
  for (let i = 0; i < 7; i++) st.list.push(st.make(i));
  st.restart = (i) => { st.dbs[i].close(); st.list[i] = st.make(i); };
  st.tick = async (from, to, which = [0, 1, 2, 3, 4, 5, 6], passes = true) => { for (let t = from; t <= to; t += 10000) { st.clock = t; for (const k of which) await st.list[k].read(); if (passes) for (const k of which) await st.list[k].pass(); } };
  return st;
}

test('#1489 a44 refute 91-s1-1: three drawn seats back 25 min after the window ended (still due) sign the window they read', async () => {
  const n = net();
  await n.tick(780000, 1800000, undefined, false);          // every seat reads the whole window
  for (const i of [0, 1, 2]) n.dbs[i].close();               // one host goes down at the window's end
  await n.tick(1810000, 3300000, [3, 4, 5, 6]);              // the other four read and pass on (4 words: no 5 of 7)
  for (const i of [0, 1, 2]) n.list[i] = n.make(i);          // back at end + 25 min: server.js due() still lists the round (30 min)
  await n.tick(3310000, 3330000);
  console.log('  MEASURED: words', n.list.map((a) => (a.served(ROUND) ? 'S' : '-')).join(''), '| held at', n.held.size, '| seat 0 earliest kept reading', String(n.list[0].samples[0]?.atMs), 'ms (window start - 60 s = 840000)');
  for (const i of [0, 1, 2]) assert.ok(n.list[i].served(ROUND), `seat ${i} read the whole window and, back while the round is still due, signs no word: its readings were pruned at KEEP_MS`);
  assert.ok(n.held.size >= 5, `held at ${n.held.size} seats: the market is VOID`);
});

test('#2186: with no round due the readings are still pruned at KEEP_MS (2 h), the one in force at the cut kept, in memory and in the store', async () => {
  const { KEEP_MS } = await import('../src/drawn-attestor.js');
  const dir = mkdtempSync(join(tmpdir(), 'a44r91s1k-')); let clock = 0; let due = [];
  const make = (db) => new DrawnAttestor({ db, selfKey: KEYS[0], sign: (d) => schnorr.sign(d, secretOf(0)), verify, attestorsFor: () => KEYS, peersFor: () => [], due: () => due, hold: async () => true, readPrice: () => 8000000, now: () => clock });
  const db = new DatabaseSync(join(dir, 's.sqlite')); let a = make(db);
  for (clock = 0; clock <= KEEP_MS + 600000; clock += 10000) await a.read();
  assert.equal(Number(a.samples[0].atMs), 600000, 'the reading at now - KEEP_MS is the first one kept');
  assert.equal(db.prepare('SELECT MIN(at_ms) AS m FROM drawn_samples').get().m, 600000);
  due = [{ roundId: ROUND, window: { startMs: 900000n, endMs: 1800000n } }];   // a round still due holds its start - 60 s
  for (; clock <= KEEP_MS + 1200000; clock += 10000) await a.read();
  assert.equal(Number(a.samples[0].atMs), 840000, 'a minute before a due round\'s start is kept past KEEP_MS');
  db.close(); a = make(new DatabaseSync(join(dir, 's.sqlite')));
  assert.equal(Number(a.samples[0].atMs), 840000, 'and read back from the store after a restart');
});
