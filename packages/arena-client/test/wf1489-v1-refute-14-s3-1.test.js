// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 REFUTE 14 (skeptic 3), ROLE: A MINORITY OF SEATS, PATH: FRESH DEVICE / RELOAD. f9581d3ae sends a seat to the back of the
// owed scan's order only when it has NOT ANSWERED within OWED_NEXT_MS. A seat that answers every /round?id= with a 404 (or a contract
// that is not the round) at 1.9 s - just inside OWED_NEXT_MS - counts as answered, keeps its place at the front, and costs every
// owed round 1.9 s again. Three such seats of seven at the front of the signer list cost each round ~5.7 s; reads go 4 at a time,
// so 12 owed rounds wait ~17 s before findOwedRounds returns, and the page saves nothing until it does.
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
const seed = new Uint8Array(32).fill(9);
const N = 12;
const rounds = Array.from({ length: N }, (_, i) => {
  const c = { ...base, startTimeMs: base.startTimeMs + BigInt(i) * 1000n, entryCloseMs: base.entryCloseMs + BigInt(i) * 1000n };
  const bytes = encodeRoundContract(c); const cc = decodeRoundContract(bytes); const id = toHex(roundId(cc));
  return { id, bytes, key: toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey)) };
});

test('wf1489-v1-refute-14-s3-1: seats answering /round?id= with a 404 just inside OWED_NEXT_MS do not cost every owed round again', async () => {
  PL.forgetOwedRounds();
  let liarReads = 0;
  const fetcher = (url) => {
    if (url.includes('/settled?')) return Promise.resolve({ ok: true, json: async () => ({ rounds: rounds.map((r) => ({ id: r.id, payouts: [r.key], refunds: [] })) }) });
    if (url.startsWith('https://liar') && url.includes('/round?id=')) { liarReads++; return new Promise((res) => setTimeout(() => res({ ok: false, status: 404 }), 1900)); }
    const m = url.match(/round\?id=([0-9a-f]{64})/); const r = m && rounds.find((x) => x.id === m[1]);
    return Promise.resolve(r ? { ok: true, arrayBuffer: async () => r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) } : { ok: false });
  };
  const nodes = ['https://liar1', 'https://liar2', 'https://liar3', 'https://h1', 'https://h2', 'https://h3', 'https://h4'];
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes, fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${N} owed rounds, 3 of 7 seats answering 404 at 1.9 s: ${found.length} found after ${ms} ms, ${liarReads} reads of the slow seats`);
  assert.equal(found.length, N);
  assert.ok(ms < 8000, `three slow-404 seats held the owed scan ${ms} ms for ${N} rounds (${liarReads} slow reads) - they kept their place for every round`);
});
