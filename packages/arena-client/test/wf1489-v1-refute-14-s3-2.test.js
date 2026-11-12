// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 REFUTE 14 (skeptic 3), ROLE: ONE SEAT, PATH: A BOT'S DAY OF ROUNDS. The same hole as -s3-1 with one seat: it answers every
// /round?id= at 1.9 s with a contract that is not the round asked (another real round's bytes - a well-formed answer, refused only
// by the id check). It is never "slow" (it answered), stays first, and costs every owed round 1.9 s; 48 owed rounds (a bot plays
// 12 a window) read 4 at a time wait ~23 s. Before f9581d3ae the same seat silent cost 2 s a round; answering costs it the same.
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
const seed = new Uint8Array(32).fill(11);
const N = 48;
const rounds = Array.from({ length: N }, (_, i) => {
  const c = { ...base, startTimeMs: base.startTimeMs + BigInt(i) * 1000n, entryCloseMs: base.entryCloseMs + BigInt(i) * 1000n };
  const bytes = encodeRoundContract(c); const cc = decodeRoundContract(bytes); const id = toHex(roundId(cc));
  return { id, bytes, key: toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey)) };
});
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('wf1489-v1-refute-14-s3-2: one seat answering /round?id= with the wrong round at 1.9 s does not cost every owed round again', async () => {
  PL.forgetOwedRounds();
  let liarReads = 0;
  const fetcher = (url) => {
    if (url.includes('/settled?')) return Promise.resolve({ ok: true, json: async () => ({ rounds: rounds.map((r) => ({ id: r.id, payouts: [r.key], refunds: [] })) }) });
    if (url.startsWith('https://liar') && url.includes('/round?id=')) { liarReads++; const other = rounds.find((x) => !url.includes(x.id)); return new Promise((res) => setTimeout(() => res({ ok: true, arrayBuffer: async () => ab(other.bytes) }), 1900)); }
    const m = url.match(/round\?id=([0-9a-f]{64})/); const r = m && rounds.find((x) => x.id === m[1]);
    return Promise.resolve(r ? { ok: true, arrayBuffer: async () => ab(r.bytes) } : { ok: false });
  };
  const t0 = Date.now();
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://liar', 'https://h1', 'https://h2', 'https://h3'], fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS ${N} owed rounds, one seat answering the wrong round at 1.9 s: ${found.length} found after ${ms} ms, ${liarReads} reads of it`);
  assert.equal(found.length, N);
  assert.ok(ms < 8000, `one slow-wrong seat held the owed scan ${ms} ms for ${N} rounds (${liarReads} reads of it) - it kept its place for every round`);
});
