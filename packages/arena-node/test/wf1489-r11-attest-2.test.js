// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 11 (attestations / markets): A DRAWN SEAT READS ITS PEERS' WORDS WHOLE.
// drawn-attestor.js pass() asks each of the round's other drawn attestors GET /attestation-word and reads the answer with
// `await res.json()` - no byte cap (a word is under 1 kB; the node's other peer reads are capped since #1540 / #1829). One drawn seat
// answers a body of hundreds of MB: every honest drawn seat - the SEAT PROCESS itself, its settlement, its doors - buffers it, decodes
// it into one string and JSON.parses it on every pass (every 10 s), for every drawn round of the last 30 minutes. A body past the
// heap kills the seat; one a little smaller holds its one thread for seconds each pass. The drawn seat is any node of the census
// the sortition picks, so one bonded node does this to every other seat drawn with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DrawnAttestor } from '../src/drawn-attestor.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = new Uint8Array(32).fill(0x32);
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

// THE BAD DRAWN SEAT'S ANSWER: a JSON body of `total` bytes, streamed in 64 KiB chunks (as a socket hands them on); `pulled` counts what
// the stream produced - the reader's own read-ahead of one chunk included
function hugeAnswer(total, meter) {
  const chunk = new TextEncoder().encode('x'.repeat(64 << 10));
  let sent = 0, opened = false;
  const body = new ReadableStream({
    pull(ctrl) {
      if (!opened) { opened = true; const head = new TextEncoder().encode('{"pad":"'); meter.pulled += head.length; sent += head.length; return ctrl.enqueue(head); }
      if (sent >= total) { const tail = new TextEncoder().encode('"}'); meter.pulled += tail.length; ctrl.enqueue(tail); return ctrl.close(); }
      meter.pulled += chunk.length; sent += chunk.length; ctrl.enqueue(chunk.slice());
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('one drawn seat answering /attestation-word with a 64 MB body: an honest drawn seat reads a bounded part of it and still holds the 5 of 7', { timeout: 110000 }, async () => {
  let clock = 0;
  const held = new Map();
  const meter = { pulled: 0, asks: 0 };
  const BAD = 6;
  const list = KEYS.map((key, i) => new DrawnAttestor({
    selfKey: key, sign: (d) => schnorr.sign(d, secretOf(i)), verify, attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i), due: () => [{ roundId: ROUND, window: WINDOW }],
    readPrice: () => (clock < 900000 ? 8000000 : { cents: 8001234, atMs: clock }), now: () => clock,
    hold: async (bytes) => { const st = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS }); if (st.ok) held.set(i, st); return st.ok; },
    fetcher: async (url) => {
      const j = Number(new URL(url).host.split('-')[1]);
      if (j === BAD) { meter.asks += 1; return hugeAnswer(64 << 20, meter); }
      const w = list[j].served(ROUND);
      return w ? new Response(JSON.stringify(w), { status: 200 }) : new Response('none', { status: 404 });
    },
  }));
  for (let t = 780000; t <= 1810000; t += 10000) { clock = t; for (const s of list) await s.read(); }
  // seat 0, honest, makes its word and asks the others - the bad seat among them
  const t0 = Date.now();
  for (let round = 0; round < 2; round++) for (const [i, a] of list.entries()) if (i !== BAD) await a.pass();
  const ms = Date.now() - t0;
  console.log(`  bytes the honest seats read of the bad seat's answers: ${meter.pulled} (${(meter.pulled / 1048576).toFixed(1)} MiB) in ${ms} ms; held at ${held.size} seats`);
  // SAFE: a word is under 1 kB - a peer's answer is read up to a small bound and dropped past it, as the node's other peer reads are
  // (kanban #2458: per ask at most the cap plus the stream's chunks around it - 640 MiB in 10 asks before the fix)
  assert.ok(meter.asks > 0 && meter.pulled <= meter.asks * (256 << 10), `the honest drawn seats read ${(meter.pulled / 1048576).toFixed(1)} MiB in ${meter.asks} asks of one drawn seat's /attestation-word answers: no bound`);
  assert.ok(meter.pulled < 4 << 20, `the honest drawn seats read ${(meter.pulled / 1048576).toFixed(1)} MiB`);
  assert.ok(held.size >= 6, `held at ${held.size} seats`);
});
