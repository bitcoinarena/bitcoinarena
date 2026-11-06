// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1199, THE #1196 RULING ON A SEAT (spec §27A.7.4, §27A.7.6): the tally decides a proposal published at or after the
// network's BALLOT_DEPTH_HEIGHT no less than 3 deep and never counts one whose activation leaves fewer than 3 blocks after its
// last voting block; a proposal published before it keeps the old rule (depth 1). And proposals.add refuses at intake what the
// rule makes invalid on its face, only from the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS, depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 60000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 40000000n }];
const NET = toHex(H(0x4e));
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

/** A kept record: published at 100, voting from 100 + review for `voting` blocks, activation `cooldown` after. */
function kept({ publishedAt = 100, review = 0, voting = 7, cooldown = 0 } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash: H(0x22), config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: NET, parent: toHex(p.parent),
    configHash: toHex(p.configHash), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: publishedAt + review,
    votingUntil: publishedAt + review + voting, activationHeight, repeal: false } };
}
const memStore = (records) => { const rows = new Map(records.map((r) => [r.id, r])); return { read: () => [...rows.values()], write: (l) => { for (const x of l) rows.set(x.id, x); } }; };
const seat = (records) => createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify, store: memStore(records) });

/** Run the tally tip by tip from 100 to 115; answers the height it decided at (or null) and the phase it shows. */
async function decideAt({ cooldown, depthHeight, minDepth = 3, decideDepth = 6 }) {
  const k = kept({ cooldown });
  const votes = new Map([[101, [vote(A, k.idBytes, CHOICE.YES, 101, 'a1')]], [102, [vote(B, k.idBytes, CHOICE.YES, 102, 'b1')]]]);
  const proposals = seat([k.record]);
  let tip = 0;
  const logs = [];
  const t = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => decideDepth, minDecideDepthFor: () => minDepth, depthHeightFor: () => depthHeight, log: (l) => logs.push(l) });
  for (tip = 100; tip <= 115; tip++) await t.pass();
  const p = proposals.list()[0];
  return { decidedAt: p.decided ? p.decided.decidedAt : null, state: p.state, phase: t.list()[0].phase, activation: k.record.activationHeight, logs };
}

test('#1199 below the gate a proposal keeps the old rule: decided at depth 1 when its activation leaves no more', async () => {
  // a repeal's old shape: voting 100-106, cooldown 0, activation 107; published 100, the gate at 101
  const r = await decideAt({ cooldown: 0, depthHeight: 101 });
  console.log('  #1199 BELOW:', JSON.stringify({ decidedAt: r.decidedAt, state: r.state, activation: r.activation }));
  assert.deepEqual([r.decidedAt, r.state], [106, 'PASSED'], 'the last voting block 1 deep, the block before its activation');
  // and with room, the usual 6 deep (min(6, activation - votingUntil + 1))
  assert.equal((await decideAt({ cooldown: 10, depthHeight: 101 })).decidedAt, 111);
});

test('#1199 at or after the gate: decided 3 deep at least, and a too-short activation is never counted', async () => {
  // cooldown 2 (the ruled repeal cooldown): 3 deep at 108, the block before its activation 109
  const two = await decideAt({ cooldown: 2, depthHeight: 100 });
  assert.deepEqual([two.decidedAt, two.activation, two.state], [108, 109, 'PASSED']);
  // cooldown 0 and 1: fewer than 3 blocks after the last voting block - invalid on its face, never decided
  for (const cooldown of [0, 1]) {
    const r = await decideAt({ cooldown, depthHeight: 100 });
    console.log('  #1199 AT THE GATE:', JSON.stringify({ cooldown, decidedAt: r.decidedAt, state: r.state, phase: r.phase }));
    assert.deepEqual([r.decidedAt, r.state, r.phase], [null, 'COUNTING', 'invalid'], `cooldown ${cooldown}`);
    assert.equal(r.logs.filter((l) => /invalid on its face/.test(l)).length, 1, 'said once');
  }
  // the gate at 0 (mainnet, regtest) is the same as at 100
  assert.equal((await decideAt({ cooldown: 0, depthHeight: 0 })).decidedAt, null);
  // testnet4 as set now (Infinity): the old rule
  assert.equal((await decideAt({ cooldown: 0, depthHeight: Number.POSITIVE_INFINITY })).decidedAt, 106);
});

test('#1199 regtest under the rule keeps depth 1 and its 1 / 6 / 1 schedule', async () => {
  const r = await decideAt({ cooldown: 1, depthHeight: 0, minDepth: 1, decideDepth: 1 });
  assert.deepEqual([r.decidedAt, r.state, r.activation], [106, 'PASSED', 108]);
});

// INTAKE: proposals.add with a deposit on this seat's chain
const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
function posted(config, activationHeight) {
  const want = depositOutputsExpected(1000, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: H(0x4e), parent: H(0x10), configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  return { raw, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), A.secret)])) };
}
const intake = (extra) => {
  const chain = new Map();
  const book = createProposals({ confirmedTx: async (txid) => chain.get(txid) || null, recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, store: memStore([]), ...extra });
  return async (config, activation) => {
    const x = posted(config, activation);
    chain.set(toHex(Uint8Array.from(parseTransaction(x.raw).txid).reverse()), { raw: x.raw, height: 200 });
    return book.add({ proposal: x.hex, blockHash: 'bb'.repeat(32) });
  };
};

test('#1199 intake: a repeal at or after the gate needs its 2-block cooldown; below it the old 0', async () => {
  // a repeal of config 1 (live before 2): published 200, voting 200-919, mainnet's 0 / 720 / 2
  const history = () => [{ config: Uint8Array.of(1) }, { config: Uint8Array.of(2) }];
  const at = intake({ historyFor: history, repealSchedule: REPEAL_SCHEDULES.mainnet, depthHeightFor: () => 200, minDecideDepthFor: () => 3 });
  const r = await at(Uint8Array.of(1), 920);
  assert.equal(r.status, 422); assert.match(r.why, /before the end of cooldown \(922\)/);
  assert.equal((await at(Uint8Array.of(1), 922)).status, 201);
  const below = intake({ historyFor: history, repealSchedule: REPEAL_SCHEDULES.mainnet, depthHeightFor: () => 201, minDecideDepthFor: () => 3 });
  const old = await below(Uint8Array.of(1), 920);
  assert.deepEqual([old.status, old.repeal, old.votingUntil], [201, true, 920], old.why);
});

test('#1199 intake: an activation fewer than 3 blocks after the last voting block is refused at or after the gate, taken below it', async () => {
  const short = { ...SCHEDULES.mainnet, [CLASS.DESIGN]: { review: 1, voting: 6, cooldown: 0 } };   // voting 201-206: activation 207 is 1 block after
  const at = intake({ schedule: short, depthHeightFor: () => 200, minDecideDepthFor: () => 3 });
  const r = await at(Uint8Array.of(7), 207);
  console.log('  #1199 INTAKE:', JSON.stringify({ status: r.status, why: r.why }));
  assert.equal(r.status, 422); assert.match(r.why, /invalid on its face/);
  assert.equal((await at(Uint8Array.of(7), 209)).status, 201, '3 blocks after: taken');
  const below = intake({ schedule: short, depthHeightFor: () => 201, minDecideDepthFor: () => 3 });
  assert.equal((await below(Uint8Array.of(7), 207)).status, 201);
  // regtest's own schedule under the rule (gate 0, depth 1): 1 / 6 / 1 is taken
  const reg = intake({ schedule: SCHEDULES.regtest, depthHeightFor: () => 0, minDecideDepthFor: () => 1 });
  const g = await reg(Uint8Array.of(8), 208);
  assert.deepEqual([g.status, g.votingFrom, g.votingUntil], [201, 201, 207], g.why);
});
