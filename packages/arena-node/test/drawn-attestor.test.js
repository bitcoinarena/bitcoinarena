// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS ATTEST A ROUND THEMSELVES (kanban #630, protocol 21): seven drawn seats each sign the outcome from their own readings, ask the
// others, and hold the attestation once 5 signed one body - which stands against the round's draw and nothing else. Two seats down: it still
// stands; three down: no attestation (the round is refunded at its deadline, as an unattested market is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DrawnAttestor } from '../src/drawn-attestor.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = new Uint8Array(32).fill(0x31);
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

function seats({ down = [] } = {}) {
  let clock = 0;
  const held = new Map();
  const list = KEYS.map((key, i) => new DrawnAttestor({
    selfKey: key, sign: (d) => schnorr.sign(d, secretOf(i)), attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => (clock < 900000 ? 8000000 : { cents: 8001234, atMs: clock }), now: () => clock,
    hold: async (bytes) => { const st = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS }); if (st.ok) held.set(i, st); return st.ok; },
    fetcher: async (url) => {
      const j = Number(new URL(url).host.split('-')[1]);
      const w = down.includes(j) ? null : list[j].served(ROUND);
      return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null };
    },
  }));
  return { list, held, tick: async (ms) => { clock = ms; for (const [i, s] of list.entries()) if (!down.includes(i)) await s.read(); } };
}

async function run(down) {
  const s = seats({ down });
  for (let t = 780000; t <= 1810000; t += 10000) await s.tick(t);
  for (let round = 0; round < 2; round++) for (const [i, a] of s.list.entries()) if (!down.includes(i)) await a.pass();
  return s;
}

test('seven drawn seats attest a window themselves: 5 of 7 over one body, held at every seat that combined it', async () => {
  const s = await run([]);
  console.log('  ALL UP:', JSON.stringify([...s.held.values()].map((x) => x.why)[0]), 'held at', s.held.size, 'seats');
  assert.equal(s.held.size, 7);
  for (const st of s.held.values()) { assert.equal(st.outcome, 0); assert.ok(st.signers >= 5); }
});

test('two drawn seats down: it still stands; three down: no attestation', async () => {
  const two = await run([5, 6]);
  assert.equal(two.held.size, 5, 'the five up did not hold it');
  const three = await run([4, 5, 6]);
  console.log('  DOWN 2 -> held at', two.held.size, '| DOWN 3 -> held at', three.held.size);
  assert.equal(three.held.size, 0, 'four signatures made an attestation');
});

// A MARKET WITH ITS OWN SOURCE (kanban #920): the word comes from its source at the end of the round, a failed read is tried again, a "rises" market reads at its start
test('a source market is signed from its source, once, and a failed read waits for the next pass', async () => {
  const roundId = new Uint8Array(32).fill(7), self = 'ab'.repeat(32); let answer = { ok: false, why: 'no' }, runs = 0; const seen = [];
  const a = new DrawnAttestor({ readPrice: async () => null, selfKey: self, sign: () => new Uint8Array(64).fill(1), attestorsFor: () => [self], peersFor: () => [], due: () => [], hold: async () => true, threshold: 1, now: () => 10000000,
    runSource: async (source, market) => { runs++; seen.push(market); return answer; } });
  const r = { roundId, window: { startMs: 0n, endMs: 1000n }, source: { kind: 1, rule: 1 }, outcomes: ['Yes', 'No'] };
  assert.equal(await a.wordForSource(r), null);
  answer = { ok: true, out: 'Maybe' };
  assert.equal(await a.wordForSource(r), null);
  answer = { ok: true, out: 'No' };
  const w = await a.wordForSource(r);
  assert.equal(w.body.outcome, 1); assert.equal(w.body.observedAtMs, 1000n);
  assert.equal(await a.wordForSource(r), w);
  assert.equal(runs, 3);
  const early = new DrawnAttestor({ selfKey: self, attestorsFor: () => [self], sign: () => new Uint8Array(64), now: () => 500, runSource: async () => { throw new Error('too early'); } });
  assert.equal(await early.wordForSource(r), null);
});

test('a rising market reads when its window opens and is compared to that', async () => {
  const roundId = new Uint8Array(32).fill(8), self = 'ab'.repeat(32); const asked = [];
  const r = { roundId, window: { startMs: 0n, endMs: 1000n }, source: { kind: 1, rule: 3 }, outcomes: ['Up', 'Down'] };
  const a = new DrawnAttestor({ readPrice: async () => null, selfKey: self, sign: () => new Uint8Array(64), attestorsFor: () => [self], now: () => 10000000, opening: () => [r],
    runSource: async (s, m) => { asked.push([s.rule, m.start]); return s.rule === 0 ? { ok: true, out: 100 } : { ok: true, out: 'Up' }; } });
  await a.read(); await a.read();
  assert.equal(asked.length, 1);
  assert.equal((await a.wordForSource(r)).body.outcome, 0);
  assert.deepEqual(asked[1], [3, 100]);
});

// kanban #1376 (audit 2 #1204 MKT-3): a restarted drawn attestor serves the word it signed - never a second outcome from a later read of the source
test('#1376 after a restart the source market\'s word is the one signed before, and a rising market keeps its opening value', async () => {
  const self = 'ab'.repeat(32);
  const memStore = () => { const w = new Map(), s = new Map(); return { word: (id) => w.get(id) || null, keepWord: (id, j) => { if (!w.has(id)) w.set(id, j); return w.get(id); },
    start: (id) => (s.has(id) ? s.get(id) : undefined), keepStart: (id, v) => { if (!s.has(id)) s.set(id, v); } }; };
  const store = memStore();
  const r = { roundId: new Uint8Array(32).fill(9), window: { startMs: 0n, endMs: 1000n }, source: { kind: 1, rule: 1 }, outcomes: ['Yes', 'No'] };
  const make = (out, runs) => new DrawnAttestor({ readPrice: async () => null, selfKey: self, sign: () => new Uint8Array(64).fill(1), attestorsFor: () => [self], peersFor: () => [],
    due: () => [], hold: async () => true, threshold: 1, now: () => 10000000, store, runSource: async () => { runs.n++; return { ok: true, out }; } });
  const first = { n: 0 }, again = { n: 0 };
  const w1 = await make('Yes', first).wordForSource(r);
  // THE RESTART: the source now reads the other way
  const restarted = make('No', again);
  const w2 = await restarted.wordForSource(r);
  console.log(`#1376 signed ${w1.body.outcome}, after the restart ${w2.body.outcome} (source read again: ${again.n})`);
  assert.equal(w2.body.outcome, w1.body.outcome, 'a second outcome signed by one key');
  assert.equal(again.n, 0, 'the source was read again after the restart');
  assert.equal(restarted.served(r.roundId).body.outcome, 0);
  // A RISING MARKET: its opening value survives the restart
  const rise = { roundId: new Uint8Array(32).fill(10), window: { startMs: 0n, endMs: 1000n }, source: { kind: 1, rule: 3 }, outcomes: ['Up', 'Down'] };
  const opener = new DrawnAttestor({ readPrice: async () => null, selfKey: self, sign: () => new Uint8Array(64), attestorsFor: () => [self], now: () => 10000000, opening: () => [rise], store,
    runSource: async (s) => (s.rule === 0 ? { ok: true, out: 100 } : { ok: true, out: 'Up' }) });
  await opener.read();
  const asked = [];
  const after = new DrawnAttestor({ readPrice: async () => null, selfKey: self, sign: () => new Uint8Array(64), attestorsFor: () => [self], now: () => 10000000, opening: () => [], store,
    runSource: async (s, m) => { asked.push([s.rule, m.start]); return { ok: true, out: 'Up' }; } });
  const wr = await after.wordForSource(rise);
  assert.ok(wr, 'a rising market signed nothing after a restart');
  assert.deepEqual(asked, [[3, 100]]);
});
