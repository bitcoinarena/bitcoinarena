// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CONFIG BALLOT'S FIRST SLICE (spec §27A.7.2-4): the proposal on its face, the 77-byte vote, the tally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeConfigProposalBody, decodeConfigProposalBody, proposalBodyId, proposalId, proposalStands, encodeVote, decodeVote,
  voteMessage, tally, CLASS, CHOICE, SCHEDULES, VOTE_BYTES, configHashOf, TAG_GAME_CONFIG } from '../src/ballot.js';
import { taggedHash, toHex } from '../src/hash.js';
import { BALLOT_GENESIS } from '../src/ballot-chain.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const b32 = (n) => new Uint8Array(32).fill(n);
const proposer = key(1);
const draft = (over = {}) => ({ networkId: b32(0x4e), parent: b32(0x10), configHash: configHashOf(Uint8Array.from([1, 2, 3])), config: Uint8Array.from([1, 2, 3]),
  class: CLASS.DESIGN, activationHeight: 100 + 1 + 6 + 1, proposer: proposer.pubkey, depositTxid: b32(0x30), ...over });
const signed = (p) => ({ ...p, signature: schnorr.sign(proposalBodyId(p), proposer.secret) });
const facts = { publishedAt: 100, depositSats: 500, lowestBondMinSats: 50000, schedule: SCHEDULES.regtest, verify };

test('a proposal: the full config, signed by its proposer, activation not before the end of cooldown, deposit within the cap', () => {
  const p = signed(draft());
  assert.deepEqual(decodeConfigProposalBody(encodeConfigProposalBody(p)), draft());
  const s = proposalStands(p, facts);
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([s.votingFrom, s.votingUntil, s.class], [101, 107, 'DESIGN']);
  assert.equal(s.id.length, 32);
  assert.match(proposalStands(signed(draft({ activationHeight: 107 })), facts).why, /before the end of cooldown \(108\)/);
  assert.match(proposalStands(p, { ...facts, depositSats: 501 }).why, /over the cap of 500/);
  assert.match(proposalStands({ ...p, signature: schnorr.sign(proposalBodyId(p), key(2).secret) }, facts).why, /not signed by the node it names/);
  assert.throws(() => encodeConfigProposalBody(draft({ config: new Uint8Array(0) })), /FULL config, never a diff/);
  assert.throws(() => encodeConfigProposalBody(draft({ class: 9 })), /DESIGN, MONEY or UPGRADE/);
  assert.notEqual(Buffer.from(proposalId(p)).toString('hex'), Buffer.from(proposalId(signed(draft({ configHash: b32(0x21) })))).toString('hex'));
});

test('the config_hash a proposal names is the hash of the config it carries (27A.7.1): a mismatch is refused, a match stands', () => {
  // the hash the network names configs by: the genesis 2170f250 is it over its own bytes
  assert.equal(TAG_GAME_CONFIG, 'BLWP/v1/GameConfig');
  assert.equal(toHex(configHashOf(BALLOT_GENESIS.config)), toHex(BALLOT_GENESIS.configHash));
  assert.equal(toHex(configHashOf(BALLOT_GENESIS.config)), '2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d');
  // A MISMATCH, signed by its proposer and otherwise in order: refused by name, whatever it names
  const config = Uint8Array.from([1, 2, 3]);
  for (const configHash of [b32(0x20), configHashOf(Uint8Array.from([1, 2, 4])), BALLOT_GENESIS.configHash, taggedHash('BLWP/v1/Other', config)]) {
    const bad = signed(draft({ configHash, config }));
    const s = proposalStands(bad, facts);
    assert.equal(s.ok, false, 'a hash that is not the hash of the carried config is refused');
    assert.match(s.why, /is not the hash of the config the proposal carries/);
    assert.ok(s.why.includes(toHex(configHashOf(config))), 'the refusal names the hash the bytes have');
  }
  // the full genesis config with a hash of other bytes: refused too
  assert.equal(proposalStands(signed(draft({ configHash: configHashOf(config), config: BALLOT_GENESIS.config })), facts).ok, false);
  // A MATCH STANDS, for small bytes and for the real config
  const good = proposalStands(signed(draft({ configHash: configHashOf(config), config })), facts);
  assert.equal(good.ok, true, good.why);
  const real = proposalStands(signed(draft({ configHash: BALLOT_GENESIS.configHash, config: BALLOT_GENESIS.config })), facts);
  assert.equal(real.ok, true, real.why);
  // and the other checks are where they were: a matching hash does not excuse a bad signature, cooldown or deposit
  const p = signed(draft());
  assert.match(proposalStands({ ...p, signature: schnorr.sign(proposalBodyId(p), key(2).secret) }, facts).why, /not signed by the node it names/);
  assert.match(proposalStands(signed(draft({ activationHeight: 107 })), facts).why, /before the end of cooldown \(108\)/);
  assert.match(proposalStands(p, { ...facts, depositSats: 501 }).why, /over the cap of 500/);
});

test('a vote is 77 bytes: "ARN" \'V\' (2026-10-13), the proposal id\'s first 8 bytes, the choice, the bond key\'s signature', () => {
  const p = signed(draft()); const id = proposalId(p);
  const v = encodeVote({ proposalId: id, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(id, CHOICE.YES), key(5).secret) });
  assert.equal(v.length, VOTE_BYTES);
  assert.equal(v.length, 77);
  assert.equal(Buffer.from(v.subarray(0, 4)).toString(), 'ARNV');
  const d = decodeVote(v);
  assert.deepEqual([Buffer.from(d.idPrefix).toString('hex'), d.choice], [Buffer.from(id.subarray(0, 8)).toString('hex'), CHOICE.YES]);
  assert.equal(decodeVote(v.subarray(1)), null);
  const bad = Uint8Array.from(v); bad[12] = 9; assert.equal(decodeVote(bad), null);
  const fork = Uint8Array.from(v); fork[3] = 0x46; assert.equal(decodeVote(fork), null, '"ARN" \'F\' is a re-affirmation, never a vote');
});

/** Ten bonds of 10 000 sat; node i votes `choice` at `height`. */
function election(cls = CLASS.DESIGN) {
  const p = signed(draft({ class: cls }));
  const standing = proposalStands(p, facts);
  const nodes = Array.from({ length: 10 }, (_, i) => key(10 + i));
  const census = nodes.map((n, i) => ({ pubkey: n.pubkey, outpoint: `tx${i}:0`, bondSats: 10000n }));
  const vote = (i, choice, height, txid = `v${i}-${height}`) => ({ payload: encodeVote({ proposalId: standing.id,
    choice, signature: schnorr.sign(voteMessage(standing.id, choice), nodes[i].secret) }), height, txid });
  return { p, standing, census, vote };
}

test('DESIGN passes on 30 % turnout and more than half of the non-abstaining weight; ABSTAIN counts for turnout only', () => {
  const e = election();
  const yes2no1 = tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [e.vote(0, CHOICE.YES, 102), e.vote(1, CHOICE.YES, 102), e.vote(2, CHOICE.NO, 103)] });
  assert.deepEqual([yes2no1.turnoutPct, yes2no1.quorum, yes2no1.approved, yes2no1.passed], [30, true, true, true]);
  const tie = tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [e.vote(0, CHOICE.YES, 102), e.vote(1, CHOICE.NO, 102), e.vote(2, CHOICE.ABSTAIN, 103)] });
  assert.deepEqual([tie.quorum, tie.approved, tie.passed], [true, false, false], '50 % is not more than half');
  const quiet = tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [e.vote(0, CHOICE.YES, 102), e.vote(1, CHOICE.YES, 102)] });
  assert.deepEqual([quiet.turnoutPct, quiet.quorum, quiet.passed], [20, false, false], 'all yes, but 20 % turnout');
});

test('MONEY needs 40 % turnout and two thirds; UPGRADE 51 %', () => {
  const m = election(CLASS.MONEY);
  const v = [0, 1, 2, 3].map((i) => m.vote(i, i < 3 ? CHOICE.YES : CHOICE.NO, 102));
  const r = tally({ proposal: m.p, standing: m.standing, census: m.census, verify, votes: v });
  assert.deepEqual([r.turnoutPct, r.approvalPct, r.passed], [40, 75, true]);
  const u = election(CLASS.UPGRADE);
  const r2 = tally({ proposal: u.p, standing: u.standing, census: u.census, verify, votes: [0, 1, 2, 3, 4].map((i) => u.vote(i, CHOICE.YES, 102)) });
  assert.deepEqual([r2.turnoutPct, r2.quorum], [50, false], '50 % is short of UPGRADE\'s 51');
});

test('the last vote by height wins, ties go to the lower txid; votes outside the voting phase or by no bond key count nothing', () => {
  const e = election();
  const changed = tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [
    e.vote(0, CHOICE.YES, 102), e.vote(0, CHOICE.NO, 104), e.vote(1, CHOICE.YES, 103, 'b'), e.vote(1, CHOICE.NO, 103, 'a'), e.vote(2, CHOICE.YES, 102)] });
  assert.deepEqual([changed.yesSats, changed.noSats, changed.bondsVoted], [10000n, 20000n, 3]);
  const outside = tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [e.vote(0, CHOICE.YES, 100), e.vote(1, CHOICE.YES, 107)] });
  assert.equal(outside.bondsVoted, 0, 'review (100) and after the phase (107) are not counted');
  const stranger = key(99);
  const forged = { payload: encodeVote({ proposalId: e.standing.id, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(e.standing.id, CHOICE.YES), stranger.secret) }), height: 102, txid: 'x' };
  assert.equal(tally({ proposal: e.p, standing: e.standing, census: e.census, verify, votes: [forged] }).bondsVoted, 0);
});
