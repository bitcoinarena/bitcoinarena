// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 REFUTE 14 (skeptic 4), ROLE: ONE SEAT, PATH: FRESH DEVICE / RELOAD. 87fbfe6f9 moves a seat that returned a valid contract to
// the FRONT of the owed scan's order, whenever that answer arrives. The contract is public bytes (its id is its hash; any seat can copy
// it from another), so one seat answers every /round?id= with the RIGHT contract at 2100 ms (honest seats at 150 ms) - just past OWED_NEXT_MS: the timer demotes it, an honest seat answers at once, then its late valid answer promotes it back to the front (good() runs before the done check)
// - and every owed round costs that delay again. 48 rounds, 4 reads at a time: about 12 x 2100 ms before findOwedRounds returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const base = decodeRoundContract(fromHex(CONTRACT_HEX));
const seed = new Uint8Array(32).fill(5);
const N = 48;
const rounds = Array.from({ length: N }, (_, i) => {
  const c = { ...base, startTimeMs: base.startTimeMs + BigInt(i) * 1000n, entryCloseMs: base.entryCloseMs + BigInt(i) * 1000n };
  const bytes = encodeRoundContract(c); const cc = decodeRoundContract(bytes); const id = toHex(roundId(cc));
  return { id, bytes, key: toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey)) };
});

test('wf1489-v1-refute-14-s4-5: a seat answering every /round?id= with the right contract at 2100 ms (honest seats at 150 ms) does not cost every owed round again', async () => {
  PL.forgetOwedRounds();
  let lateReads = 0;
  const body = (r) => ({ ok: true, arrayBuffer: async () => r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) });
  const fetcher = (url) => {
    if (url.includes('/settled?')) return Promise.resolve({ ok: true, json: async () => ({ rounds: rounds.map((r) => ({ id: r.id, payouts: [r.key], refunds: [] })) }) });
    const m = url.match(/round\?id=([0-9a-f]{64})/); const r = m && rounds.find((x) => x.id === m[1]);
    if (url.startsWith('https://late')) { lateReads++; return new Promise((res) => setTimeout(() => res(r ? body(r) : { ok: false }), 2100)); }
    return new Promise((res) => setTimeout(() => res(r ? body(r) : { ok: false }), 150));
  };
  const nodes = ['https://late', 'https://h1', 'https://h2', 'https://h3', 'https://h4', 'https://h5', 'https://h6'];
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes, fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${N} owed rounds, one seat answering the right contract at 2100 ms (honest seats at 150 ms): ${found.length} found after ${ms} ms, ${lateReads} reads of it`);
  assert.equal(found.length, N);
  assert.ok(ms < 5000, `one seat answering at 2100 ms (honest seats at 150 ms) held the owed scan ${ms} ms for ${N} rounds (${lateReads} reads of it): its valid answer kept it first`);
});
