// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 REFUTE 14 (skeptic 2), ROLE: ONE SEAT, PATH: RELOAD/RESUME. The owed scan saves nothing until every matched round's contract
// is read (index.html findTheRoundsOwed saves after findOwedRounds returns). One seat first in the signer list that takes /round?id=
// and never answers costs OWED_NEXT_MS (2 s) for EVERY owed round, read one after another. A fresh device (the iPhone of spec §24)
// owed 12 rounds from the last 24 h waits ~24 s before anything is kept; a reload before that starts again from nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signedSeats } from './settled-signed.js';   // kanban #2108: seats sign their /settled answers

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const base = decodeRoundContract(fromHex(CONTRACT_HEX));
const seed = new Uint8Array(32).fill(7);
const N = 12;
const rounds = Array.from({ length: N }, (_, i) => {
  const c = { ...base, startTimeMs: base.startTimeMs + BigInt(i) * 1000n, entryCloseMs: base.entryCloseMs + BigInt(i) * 1000n };
  const bytes = encodeRoundContract(c); const cc = decodeRoundContract(bytes); const id = toHex(roundId(cc));
  return { id, bytes, key: toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey)) };
});

test('wf1489-v1-refute-14-s2-1: one seat silent on /round?id= does not make a fresh device wait 2 s per owed round', async () => {
  PL.forgetOwedRounds();
  const fetcher = (url) => {
    if (url.startsWith('https://liar') && url.includes('/round?id=')) return new Promise(() => {});
    if (url.includes('/settled?')) return Promise.resolve({ ok: true, json: async () => ({ rounds: rounds.map((r) => ({ id: r.id, payouts: [r.key], refunds: [] })) }) });
    const m = url.match(/round\?id=([0-9a-f]{64})/); const r = m && rounds.find((x) => x.id === m[1]);
    return Promise.resolve(r ? { ok: true, arrayBuffer: async () => r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) } : { ok: false });
  };
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://liar', 'https://h1', 'https://h2'], ...signedSeats(fetcher, ['https://liar', 'https://h1', 'https://h2']), sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${N} owed rounds, one seat silent on /round: ${found.length} found after ${ms} ms (nothing saved before)`);
  assert.equal(found.length, N);
  assert.ok(ms < 8000, `one silent seat held the owed scan ${ms} ms for ${N} rounds - ~${Math.round(ms / N)} ms per round`);
});
