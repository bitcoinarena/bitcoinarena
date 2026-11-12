// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2015, #2049 (#1489 refute-0-s3): the fix's two halves on their own. FOUR cheaply bonded colluders: each claimant has three OTHER census
// nodes of the committee as witnesses, so "not its own witness" alone does not stop them - the round must also be held by a seat the caller
// trusts (censusSeats). The same committee with the trusted seat holding the round passes; the trusted seat holding a different committee does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const TRUSTED = 'https://trusted.example';
const KEYS = [0x71, 0x72, 0x73, 0x74].map((b) => { const sk = new Uint8Array(32).fill(b); return { sk, pk: toHex(schnorr.getPublicKey(sk)) }; });
const RID = toHex(new Uint8Array(32).fill(0x6b));
const END = Object.fromEntries(KEYS.map((k, i) => [k.pk, `wss://col${i + 1}.example`]));
const COMMITTEE = KEYS.map((k) => k.pk);
const fins = KEYS.map((k) => toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(k.pk), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, k.sk))));
const roles = KEYS.map((k) => ({ node: k.pk, endpoint: END[k.pk], bondSats: '50000' }));

const world = (trustedHeld) => async (url) => {
  if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
  if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : { nodes: [] };
  if (url.startsWith(`${TRUSTED}/`)) return { node: 'f0'.repeat(32), held: trustedHeld };
  const who = KEYS.find((k) => url.startsWith(`${END[k.pk].replace(/^wss:/, 'https:')}/`));
  if (who) return { node: who.pk, held: [{ roundId: RID, committee: COMMITTEE, finals: fins }] };
  return { node: null, held: [] };
};
const says = (r) => r.checks.find((c) => c.key === 'committees').says;

test('#2015 #2049: four colluders, three other witnesses each - no trusted seat holds the round, none passes', async () => {
  const rs = await Promise.all(KEYS.map((k) => nodeBountyCheck({ node: k.pk, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson: world([]) })));
  console.log('  MEASURED #2015 four colluders, no trusted seat:', JSON.stringify(rs.map((r) => [r.passes, says(r)])));
  assert.deepEqual(rs.map((r) => r.passes), [false, false, false, false]);
  for (const r of rs) assert.match(says(r), /^0 committees/);
});

test('#2015 #2049: the trusted seat holding the same round and committee confirms it; another committee under that id does not', async () => {
  const same = await nodeBountyCheck({ node: KEYS[0].pk, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson: world([{ roundId: RID, committee: COMMITTEE, finals: [] }]) });
  const other = await nodeBountyCheck({ node: KEYS[0].pk, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson: world([{ roundId: RID, committee: [KEYS[0].pk, 'f0'.repeat(32)], finals: [] }]) });
  console.log('  MEASURED #2015 trusted confirms:', JSON.stringify({ same: [same.passes, says(same)], other: [other.passes, says(other)] }));
  assert.equal(same.passes, true);
  assert.equal(says(same), '7 committees, 7 signed rounds');
  assert.equal(other.passes, false);
});
