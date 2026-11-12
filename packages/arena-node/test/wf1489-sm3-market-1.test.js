// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 state machine audit, round 3, market area (SM-6 drawn attestor): A DRAWN SEAT RESTARTED AFTER ITS ROUND'S WINDOW ENDED NEVER SIGNS IT.
// The drawn attestor keeps its price readings in memory only (drawn-attestor.js `samples`), unlike the fixed attestor daemon, which keeps
// them on disk across a restart (arena-attestor.mjs SAMPLES_FILE). A seat that read the whole window and restarts in the seconds after its
// end (a host reboot, a roll of the seats on one machine) comes back with no reading before the window's start - upDownOutcome answers "no
// reading a minute before the window's start" and it never signs the round. Three of the seven drawn seats restarted together: no 5 of 7,
// no attestation, the market VOID at its deadline and every stake of it handed back - although all seven seats read the window.
// The fix (kanban #1844): the readings and signed words live in the seat's store (server.js passes round.db); a restart here closes a
// seat's store and opens it again, as a new process does.
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

const ROUND = new Uint8Array(32).fill(0x41);
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

test('#1489 sm3 market 1: three drawn seats restarted just after the window ended still attest the window they read', async () => {
  let clock = 0;
  const held = new Map();
  const list = [];
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm3-market-1-'));
  const dbs = [];
  // one seat's attestor, as server.js builds it at start - a restart builds a new one with the same keys and doors
  const make = (i) => new DrawnAttestor({
    db: (dbs[i] = new DatabaseSync(join(dir, `seat-${i}.sqlite`))),
    selfKey: KEYS[i], sign: (d) => schnorr.sign(d, secretOf(i)), verify, attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => (clock < 900000 ? 8000000 : { cents: 8001234, atMs: clock }), now: () => clock,
    hold: async (bytes) => { const st = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS }); if (st.ok) held.set(i, st); return st.ok; },
    fetcher: async (url) => {
      const j = Number(new URL(url).host.split('-')[1]);
      const w = list[j].served(ROUND);
      return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null };
    },
  });
  for (let i = 0; i < 7; i++) list.push(make(i));
  // EVERY SEAT READS THE WHOLE WINDOW (from a minute before its start to its end)
  for (let t = 780000; t <= 1800000; t += 10000) { clock = t; for (const a of list) await a.read(); }
  // ONE HOST REBOOTS JUST AFTER THE WINDOW'S END, BEFORE ITS SEATS' FIRST PASS: seats 0, 1, 2 come back
  const before = list.slice(0, 3).map((a) => a.samples.length);
  for (const i of [0, 1, 2]) { dbs[i].close(); list[i] = make(i); }
  for (let t = 1810000; t <= 1830000; t += 10000) {
    clock = t;
    for (const a of list) await a.read();
    for (const a of list) await a.pass();
  }
  const words = list.map((a) => (a.served(ROUND) ? 'signed' : 'none'));
  console.log('  MEASURED: readings before the restart', before, '| words after it', words.join(' '), '| attestation held at', held.size, 'seats');
  for (const i of [0, 1, 2]) assert.ok(list[i].served(ROUND), `seat ${i} read the whole window before its restart and signs no word for it after`);
  assert.ok(held.size >= 5, `all seven drawn seats read the window and no attestation of it stands (held at ${held.size} seats): the market is VOID at its deadline`);
  // SIGNED ONCE: a seat restarted after it signed serves the very word it signed before (never a second body)
  const first = JSON.stringify(list[3].served(ROUND));
  dbs[3].close(); list[3] = make(3);
  for (const a of list) await a.pass();
  assert.equal(JSON.stringify(list[3].served(ROUND)), first, 'a restarted seat serves the word it signed before its restart');
  for (const d of dbs) d.close();
});
