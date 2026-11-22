// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit census r3 finding 1: a stranger's FUNDING_UNSIGNALED_MAX (256) fee proposals, signed with 8 fresh keys (32 each, the #2522 cap),
// make every feesAt(height) - the round's feesFor, called on entries, order batches and settlement - re-read and BIP-340 re-verify all 256
// fee rows (feeFold reads every 'fee' row), and GET /fees (feeList) does that once per fee row: 256 x 256 = 65,536 verifies per request.
// SAFE: one feesAt with nothing decided verifies no stranger's row again; one feeList is linear in the rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook, FUNDING_UNSIGNALED_MAX } from '../src/funding-book.js';
const FUNDING_PER_AUTHOR_MAX = 32;                     // the 1.9 per-author cap (#2522): 8 keys either way
import { FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeFeeProposal, feeProposalId } from '../../arena-protocol/src/fee-proposal.js';
import { toHex } from '../../arena-protocol/src/hash.js';

let calls = 0;
const verify = (s, m, k) => { calls++; return schnorr.verify(s, m, k); };
const sk = (n) => { const b = new Uint8Array(32); b[0] = 9; b[30] = n >> 8; b[31] = n & 255; return b; };
const S = FUNDING_SCHEDULES.short;

test('a stranger\'s 256 fee proposals: feesAt and GET /fees do not re-verify every row on every call', async () => {
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => 100, isBonded: () => true,
    activeAt: async () => ({ ok: false, why: 'n/a' }) });
  let kept = 0;
  for (let i = 0; i < FUNDING_UNSIGNALED_MAX; i++) {
    const key = 1 + Math.floor(i / FUNDING_PER_AUTHOR_MAX);
    const p = { networkId: new Uint8Array(32).fill(7), author: schnorr.getPublicKey(sk(key)), publishedHeight: 100, activationHeight: 200,
      changes: [{ fee: 'roundNodeBps', value: 300 + (i % 100) }], purpose: `junk ${i}` };
    const id = feeProposalId(p);
    const r = await b.add('fee', toHex(Uint8Array.from([...encodeFeeProposal(p), ...schnorr.sign(id, sk(key))])));
    if (r.ok) kept++;
  }
  assert.equal(kept, FUNDING_UNSIGNALED_MAX, 'the stranger fills the unsignalled cap');

  calls = 0;
  let t = Date.now();
  b.feesAt(150);
  const feesAtCalls = calls, feesAtMs = Date.now() - t;
  calls = 0;
  t = Date.now();
  b.feeList(100);
  const listCalls = calls, listMs = Date.now() - t;
  console.log(`one feesAt: ${feesAtCalls} verifies, ${feesAtMs} ms; one feeList (GET /fees): ${listCalls} verifies, ${listMs} ms`);
  assert.ok(feesAtCalls <= 8, `one feesAt (each round's feesFor) re-verified ${feesAtCalls} stranger fee rows (${feesAtMs} ms) with no fee decided`);
  assert.ok(listCalls <= 4 * FUNDING_UNSIGNALED_MAX, `one GET /fees ran ${listCalls} BIP-340 verifies (${listMs} ms on the seat's thread)`);
});
