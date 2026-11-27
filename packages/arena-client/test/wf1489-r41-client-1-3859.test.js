// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r41 client-1: the any-federation collect (redeemPayoutsAcross, 2026.0.3 step 7) takes the FIRST seat's
// /lock-settlement `federations` answer as the round's settlement - no threshold, no agreement (the #2748 / #1163 rule of
// settlementOf is not applied). One seat of seven, listed first, answers ACCEPTED with a made-up txid that pays the winner;
// the refund at that outpoint finds nothing stored (stored_before null), the page reads it as "already spent", notes the
// payout as collected and is final - the real payout the six honest seats name is never asked for, on this load or any reload.
// SAFE: a payout is collected or noted only from a settlement the round's threshold of seats agrees on; one seat's word
// never makes it final.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redeemPayoutsAcross } from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = 'aa'.repeat(32);
const rid = b32(0x5f), seed = b32(0x51);
const round = { id: rid, protocolVersion: 3, federationId: new Uint8Array(32), stakeMsat: 1000000n };
const tab = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('one seat\'s made-up any-federation settlement does not make a winner\'s payout collected (r41 client-1)', async () => {
  const winner = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const pk = toHex(refundKeyOf(winner.pubkey));
  const REAL = 'a1'.repeat(32), FAKE = 'ff'.repeat(32);
  const listing = (txid) => ({ state: 'ACCEPTED', federations: [
    { federation: A, state: 'ACCEPTED', txid, moved: { payouts: [{ kind: 'qualifier', pk, msat: '496000' }, { kind: 'signer node', pk: '02' + '11'.repeat(32), msat: '2000' }] } }] });
  const nodes = ['http://liar', 'http://s1', 'http://s2', 'http://s3', 'http://s4', 'http://s5', 'http://s6'];
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => listing(String(url).startsWith('http://liar/') ? FAKE : REAL) });
  const asked = [];
  // the federation: the real payout contract is stored at REAL:0; nothing is stored at the made-up FAKE outpoint
  const clientFor = async () => ({ refund: async (txid, outIdx) => {
    asked.push(`${txid.slice(0, 4)}:${outIdx}`);
    return JSON.stringify(txid === REAL ? { accepted: true, stored_before: { contract_id: 'c' } } : { accepted: false, stored_before: null, error: 'no contract at that outpoint' });
  } });
  const storage = tab();
  const got = await redeemPayoutsAcross({ round, roundId: rid, seed, curve: pageCurve, storage, nodes, clientFor, fetcher });
  const reload = await redeemPayoutsAcross({ round, roundId: rid, seed, curve: pageCurve, storage, nodes, clientFor, fetcher });
  console.log(`  first look: ok ${got.ok} final ${got.final} collected ${JSON.stringify(got.collected.map((c) => [c.txid.slice(0, 4), String(c.amountMsat), c.spent]))}; asked ${asked.join(', ')}; reload kept ${reload.collected.map((c) => !!c.kept)}`);
  const real = asked.filter((a) => a.startsWith(REAL.slice(0, 4)));
  assert.ok(real.length > 0 || !got.final,
    `the six honest seats name payout ${REAL.slice(0, 8)}:0, and the page never asked for it: it took the first seat's made-up txid ${FAKE.slice(0, 8)} and closed the payout as ${got.collected.map((c) => (c.spent ? 'already spent' : 'collected')).join(', ')} (final ${got.final})`);
  assert.ok(!reload.collected.some((c) => c.kept && c.txid === FAKE), 'a reload reads the made-up settlement\'s note as collected and never collects the real payout');
});
