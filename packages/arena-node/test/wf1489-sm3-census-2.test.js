// kanban #1489 state-machine audit round 3, area census, finding 2.
// ONE DEPOSIT, ONE PROPOSAL (proposals.js backedBy, #1489) is decided per seat by ARRIVAL ORDER: the first proposal a seat keeps for a
// deposit stays, any other naming that deposit is refused 409 - at the door and in the peer pull. Two proposals over one deposit
// (the proposer re-signs with another activation height or config and posts the second to another seat - a resend with an edit -
// or posts both at once) reach two seats in different orders: seat 1 keeps A, seat 2 keeps B, and the peer pull never converges
// (each refuses the other's). Every seat counts its own proposal only; when A passes, seat 1 makes A's config live and seat 2
// never does - the seats serve and refuse different rounds from the activation on (configServesRound).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);

const want = depositOutputsExpected(1000, SET);
const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const txidDisplay = toHex(Uint8Array.from(depositTxid).reverse());
const proposal = (activationHeight, config) => {
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config,
    class: CLASS.DESIGN, activationHeight, proposer, depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
};
const seat = () => createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === txidDisplay ? { raw, height: 200 } : null),
  recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify,
  schedule: SCHEDULES.regtest, censusAt: async () => [{ pubkey: proposer }], store: { read: () => [], write: () => {} } });

test('#1489 sm3-census-2: two proposals over one deposit reaching two seats in different orders leave each seat counting another proposal', async () => {
  const A = proposal(208, Uint8Array.of(1, 2, 3));
  const B = proposal(209, Uint8Array.of(1, 2, 3));        // the same proposal re-signed with another activation height
  const s1 = seat(), s2 = seat();
  const [a1, b2] = await Promise.all([s1.add({ proposal: A, blockHash: BLOCK }), s2.add({ proposal: B, blockHash: BLOCK })]);
  assert.deepEqual([a1.status, b2.status], [201, 201], `${a1.why || ''} ${b2.why || ''}`);
  // the peer pull, both ways (server.js pullProposals, every 10 min)
  const took1 = await s1.pull(s2.list()), took2 = await s2.pull(s1.list());
  const ids = (s) => s.list().map((p) => p.id.slice(0, 16)).sort();
  console.log('  after the pull both ways:', JSON.stringify({ seat1: ids(s1), seat2: ids(s2), took1, took2,
    seat1RefusesB: (await s1.add({ proposal: B, blockHash: BLOCK })).status, seat2RefusesA: (await s2.add({ proposal: A, blockHash: BLOCK })).status }));
  assert.deepEqual(ids(s1), ids(s2), 'two seats keep - and count - the same proposals for one deposit');
  // kanban #1840: a deposit backing two kept proposals backs none - both void at both seats, so neither seat makes either live
  const counted = (s) => s.list().filter((p) => s.counts(p.id)).length;
  assert.deepEqual([counted(s1), counted(s2)], [0, 0], 'a deposit its proposer signed twice counts for neither proposal, at every seat');
});
