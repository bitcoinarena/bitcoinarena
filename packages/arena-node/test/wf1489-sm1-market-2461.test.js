// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 state machine audit (markets, SM-6 drawn attestor + crash/restart): A DRAWN SEAT THAT WAS DOWN OVER ITS ROUND'S WINDOW END SIGNS
// THAT WINDOW'S OUTCOME FROM A PRICE IT READ BEFORE IT WENT DOWN.
// The #1844 fix keeps a seat's readings in its store (drawn_samples) and reads the last KEEP_MS (40 min) back at start, so a seat restarted
// just after the end still signs a window it read. But nothing checks that the restored readings COVER the window's end: upDownPrices takes
// each reading as "valid from its time until the next", so the last reading before the downtime stands for the whole gap - the END PRICE
// (the 60 s average ending at the window's end) of a seat that read nothing in that minute is the price of minutes before it.
// Path: every drawn seat reads the window up to end - 5 min (price up); one host carrying the seats goes down (power cut, reboot, a roll of
// the seats on one machine); the price falls in the last 5 minutes; the seats come back 5 s after the end, restore their readings and sign
// "observed at the window's end: Up" over bytes they never read. Before #1844 such a seat signed nothing (no reading restored) and the round
// was VOID at its deadline, every stake back; now 5 of 7 restarted seats make an attestation that stands and the market pays the wrong side.
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

const ROUND = new Uint8Array(32).fill(0x52);
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

// the market's real price: 80,000.00 before the window, 81,000.00 in it - and 79,000.00 over its last five minutes (the true outcome is Down)
const priceAt = (t) => (t < 900000 ? 8000000 : t < 1500000 ? 8100000 : 7900000);

test('#1489 sm1 market 1: drawn seats down over the window end do not sign that window from a price read before their downtime', async () => {
  let clock = 0;
  const held = new Map();
  const list = [];
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-market-1-'));
  const dbs = [];
  const make = (i) => new DrawnAttestor({
    db: (dbs[i] = new DatabaseSync(join(dir, `seat-${i}.sqlite`))),
    selfKey: KEYS[i], sign: (d) => schnorr.sign(d, secretOf(i)), verify, attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => ({ cents: priceAt(clock), atMs: clock }), now: () => clock,
    hold: async (bytes) => {
      const a = decodeAttestation(bytes);
      const st = attestationStands(a, { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS });
      if (st.ok) held.set(i, a.outcome);
      return st.ok;
    },
    fetcher: async (url) => {
      const j = Number(new URL(url).host.split('-')[1]);
      const w = list[j].served(ROUND);
      return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null };
    },
  });
  for (let i = 0; i < 7; i++) list.push(make(i));
  // EVERY SEAT READS from a minute before the window's start until 5 minutes before its end
  for (let t = 780000; t < 1500000; t += 10000) { clock = t; for (const a of list) await a.read(); }
  // THE HOST GOES DOWN at end - 5 min (no process runs, nothing is read) and comes back 5 s after the end: each seat is a new process on
  // its own store, as server.js builds it at start
  for (let i = 0; i < 7; i++) dbs[i].close();
  clock = 1805000;
  for (let i = 0; i < 7; i++) list[i] = make(i);
  const lastRead = Math.max(...list.map((a) => Number(a.samples[a.samples.length - 1].atMs)));
  for (let t = 1805000; t <= 1835000; t += 10000) {
    clock = t;
    for (const a of list) await a.read();
    for (const a of list) await a.pass();
  }
  const words = list.map((a) => { const w = a.served(ROUND); return w ? `${w.body.outcome === 0 ? 'Up' : 'Down'}(end ${w.endPrice})` : 'none'; });
  console.log(`  MEASURED: last reading before the window end at ${lastRead} ms (${(1800000 - lastRead) / 1000} s before it) | words ${words.join(' ')}`
    + ` | attestation held at ${held.size} seats, outcome ${[...new Set(held.values())].join(',') || '-'} | true outcome: Down (79,000.00 over the last 5 min)`);
  for (let i = 0; i < 7; i++)
    assert.equal(list[i].served(ROUND), null, `seat ${i} read nothing in the last ${(1800000 - lastRead) / 1000} s of the window and signs its end price as ${words[i]}`);
  assert.equal(held.size, 0, `an attestation of an end price no seat read stands at ${held.size} seats (outcome ${[...new Set(held.values())].join(',')}): the market pays it instead of going VOID`);
  for (const d of dbs) d.close();
});
