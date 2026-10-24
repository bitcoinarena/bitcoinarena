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
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 21,
};
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

function seats({ down = [] } = {}) {
  let clock = 0;
  const held = new Map();
  const list = KEYS.map((key, i) => new DrawnAttestor({
    selfKey: key, sign: (d) => schnorr.sign(d, secretOf(i)), attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => (clock < 900000 ? 8000000 : 8001234), now: () => clock,
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
