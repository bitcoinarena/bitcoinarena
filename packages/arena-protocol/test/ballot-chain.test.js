// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALLOT READ OFF THE CHAIN, ACTIVATION AND REPEAL (spec §27A.7.3, §27A.7.5-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { votesInBlock, liveConfig, depositOf, depositOutputsExpected, depositScriptOf, configServesRound, configForNewRound, BALLOT_GENESIS } from '../src/ballot-chain.js';
import { TESTNET4_DONATION_SET } from '../src/testnet4-donation-set.js';
import { encodeVote, voteMessage, decodeVote, CHOICE, CLASS, proposalStands, proposalBodyId, isRepeal, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../src/ballot.js';
import { splitBlock } from '../src/block.js';
import { parseTransaction } from '../src/tx.js';
import { toHex, fromHex } from '../src/hash.js';

const RAW = fromHex(readFileSync(new URL('./fixtures/regtest-block.hex', import.meta.url), 'utf8').trim());
const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
/** A legacy transaction: one input, outputs [{ sats, script }]. */
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const opReturn = (data) => Uint8Array.from([0x6a, ...(data.length <= 75 ? [data.length] : [0x4c, data.length]), ...data]);

test('every 77-byte "ARN" \'V\' OP_RETURN of a block is a vote, with its height and txid; anything else is not', () => {
  const secret = new Uint8Array(32).fill(5); const id = new Uint8Array(32).fill(0x21);
  const payload = encodeVote({ proposalId: id, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(id, CHOICE.YES), secret) });
  const voting = tx([{ sats: 0, script: opReturn(payload) }, { sats: 1000, script: Uint8Array.of(0x51) }]);
  const other = tx([{ sats: 0, script: opReturn(Uint8Array.from([0x41, 0x52, 0x4e, 1, 2, 3])) }]);
  // a fork re-affirmation ("ARN" 'F', 76 bytes) and a publication ("ARN" 'R', 36) are no votes: the kind byte and the length
  const reaffirm = tx([{ sats: 0, script: opReturn(Uint8Array.from([0x41, 0x52, 0x4e, 0x46, ...new Uint8Array(72).fill(1)])) },
    { sats: 0, script: opReturn(Uint8Array.from([0x41, 0x52, 0x4e, 0x52, ...new Uint8Array(32).fill(2)])) },
    { sats: 0, script: opReturn(Uint8Array.from([0x41, 0x52, 0x4e, 0x46, ...payload.subarray(4, 76)])) }]);
  const coinbase = splitBlock(RAW).transactions[0];
  const block = Uint8Array.from([...RAW.slice(0, 80), 4, ...coinbase, ...voting, ...other, ...reaffirm]);
  const found = votesInBlock(block, 812);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].height, toHex(found[0].payload)], [812, toHex(payload)]);
  assert.equal(found[0].txid, toHex(Uint8Array.from(parseTransaction(voting).txid).reverse()), 'display order, as bitcoind names it');
  assert.equal(decodeVote(found[0].payload).choice, CHOICE.YES);
  assert.deepEqual(votesInBlock(RAW, 1), [], 'a block of bond fundings carries no vote');
});

const H = (b) => new Uint8Array(32).fill(b);
test('the first passed proposal to activate becomes the config; a second on the same parent is void at its height', () => {
  const genesis = { configHash: H(1), config: Uint8Array.of(1) };
  const a = { id: H(0xa), parent: H(1), configHash: H(2), config: Uint8Array.of(2), activationHeight: 5000 };
  const b = { id: H(0xb), parent: H(1), configHash: H(3), config: Uint8Array.of(3), activationHeight: 6000 };
  const c = { id: H(0xc), parent: H(2), configHash: H(4), config: Uint8Array.of(4), activationHeight: 7000 };
  assert.equal(toHex(liveConfig({ genesis, passed: [a, b, c], height: 4999 }).configHash), toHex(H(1)), 'nothing before activation');
  const at = liveConfig({ genesis, passed: [c, b, a], height: 7000 });
  assert.equal(toHex(at.configHash), toHex(H(4)));
  assert.deepEqual(at.history.map((h) => [h.config[0], h.since]), [[1, 0], [2, 5000], [4, 7000]]);
  assert.equal(at.void.length, 1);
  assert.match(at.void[0].why, /parent 0101.* is not the config live at 6000/);
  // two at one height: the lower proposal id activates, the other is void
  const tie = liveConfig({ genesis, passed: [{ ...b, activationHeight: 5000 }, a], height: 5000 });
  assert.deepEqual([tie.configHash[0], toHex(tie.void[0].id)], [2, toHex(H(0xb))]);
});

test('a repeal - a config the network ran before - runs on the short schedule; a new config never does', () => {
  const secret = new Uint8Array(32).fill(9); const proposer = schnorr.getPublicKey(secret);
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const history = [{ config: Uint8Array.of(1) }, { config: Uint8Array.of(2) }];
  const make = (config, activationHeight) => {
    const p = { networkId: H(0x10), parent: H(2), configHash: configHashOf(config), config, class: CLASS.MONEY, activationHeight, proposer, depositTxid: H(0x77) };
    return { ...p, signature: schnorr.sign(proposalBodyId(p), secret) };
  };
  const facts = { publishedAt: 1000, depositSats: 100, lowestBondMinSats: 100000, verify, history };
  const back = make(Uint8Array.of(1), 1720);
  assert.equal(isRepeal(back, history), true);
  const s = proposalStands(back, facts);
  assert.deepEqual([s.ok, s.repeal, s.votingFrom, s.votingUntil], [true, true, 1000, 1720], s.why);
  const forward = make(Uint8Array.of(9), 1720);
  assert.equal(isRepeal(forward, history), false);
  const m = SCHEDULES.mainnet[CLASS.MONEY];
  assert.match(proposalStands(forward, facts).why, new RegExp(`before the end of cooldown \\(${1000 + m.review + m.voting + m.cooldown}\\)`));
  assert.equal(isRepeal(make(Uint8Array.of(2), 1720), history), false, 'the current config is no repeal: it goes nowhere');
  assert.equal(REPEAL_SCHEDULES.mainnet.voting, 720);
});

// THE DEPOSIT (RULED 2026-10-13, option A): one P2TR output per share of the network's keyed donation set, split as a donation
test('a proposal\'s deposit: its transaction pays each key of the keyed set its share; the confirmation height is the publication', () => {
  const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
  const set = [{ recipientPk: pk(1), shareBps: 6000, label: 'protocol a' }, { recipientPk: pk(2), shareBps: 4000, label: 'protocol b' }];
  const want = depositOutputsExpected(1001, set);
  assert.equal(want.ok, true, want.why);
  assert.deepEqual(want.outputs.map((o) => Number(o.sats)), [601, 400], '600.6 and 400.4 floored, the remainder 1 to the first');
  assert.equal(toHex(want.outputs[0].script), '5120' + toHex(pk(1).subarray(1)), 'P2TR to the key\'s x-only form');
  const change = { sats: 50000, script: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(9)) };
  const good = tx([{ sats: 601, script: want.outputs[0].script }, { sats: 400, script: want.outputs[1].script }, change]);
  const proposal = { depositTxid: Uint8Array.from(parseTransaction(good).txid) };
  const got = depositOf({ raw: good, height: 156400, proposal, recipients: set });
  console.log('  DEPOSIT:', JSON.stringify({ ...got, depositSats: String(got.depositSats) }));
  assert.deepEqual([got.ok, got.publishedAt, got.depositSats], [true, 156400, 1001n]);
  assert.equal(depositOutputsExpected(0, set).outputs.length, 0);
  // a split that is not the set's, another transaction, an LNURL set: refused by name
  const skewed = tx([{ sats: 500, script: want.outputs[0].script }, { sats: 501, script: want.outputs[1].script }]);
  assert.match(depositOf({ raw: skewed, height: 1, proposal: { depositTxid: Uint8Array.from(parseTransaction(skewed).txid) }, recipients: set }).why, /owes .* 601 sat, and it is paid 500/);
  assert.match(depositOf({ raw: skewed, height: 1, proposal, recipients: set }).why, /not the deposit the proposal names/);
  assert.match(depositOf({ raw: good, height: 1, proposal, recipients: TESTNET4_DONATION_SET.recipients }).why, /pays LNURLs/);
  assert.match(depositOf({ raw: good, height: null, proposal, recipients: set }).why, /confirmed at a height/);
  assert.equal(depositScriptOf(pk(2)).length, 34);
});

// GOING LIVE (§27A.7.5): a round is bound to the config live at its creation (its census height)
test('a round names the config live at its census height: before an activation the old one, after it the new one, and nothing else of the ballot\'s', () => {
  const genesis = { configHash: H(1), config: Uint8Array.of(1) };
  const a = { id: H(0xa), parent: H(1), configHash: H(2), config: Uint8Array.of(2), activationHeight: 500 };
  const back = { id: H(0xb), parent: H(2), configHash: H(1), config: Uint8Array.of(1), activationHeight: 900 };
  const none = liveConfig({ genesis, passed: [], height: 10 ** 9 }).history;
  // NO PROPOSAL PASSED: the genesis alone, live everywhere; a config the ballot never named is not governed - today's behaviour
  assert.deepEqual(configServesRound({ configHash: H(1), height: 7, history: none }), { ok: true, governed: true });
  assert.deepEqual(configServesRound({ configHash: H(9), height: 7, history: none }), { ok: true, governed: false });
  const spans = liveConfig({ genesis, passed: [a, back], height: 10 ** 9 }).history;
  const at = (hash, height) => configServesRound({ configHash: H(hash), height, history: spans });
  assert.equal(at(1, 499).ok, true, 'created before the activation: keeps the old config to the end');
  assert.equal(at(2, 499).ok, false, 'the new config is not live yet for a round created before its activation');
  assert.match(at(2, 499).why, /names config 0202.*live for rounds created 500 to 899; the config live at 499 is 0101/);
  assert.equal(at(2, 500).ok, true, 'created at the activation: the new config');
  assert.equal(at(1, 500).ok, false);
  assert.equal(at(1, 900).ok, true, 'the repeal made the old config live again');
  assert.equal(at(2, 900).ok, false);
  assert.equal(at(9, 600).governed, false, 'another config stays outside the ballot');
  // THE CREATOR'S SIDE: a round created after the activation names the new hash; one the ballot never named stays the creator's
  assert.equal(configForNewRound({ wanted: H(1), height: 600, history: spans })[0], 2);
  assert.equal(configForNewRound({ wanted: H(1), height: 499, history: spans })[0], 1);
  assert.equal(configForNewRound({ wanted: H(9), height: 600, history: spans })[0], 9);
});

test('the ballot starts at the config the rulings left live (2170f250), with its bytes: a repeal back to it is byte-identical', () => {
  assert.equal(toHex(BALLOT_GENESIS.configHash), '2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d');
  assert.equal(BALLOT_GENESIS.config.length, 74);
  const later = { id: H(0xa), parent: BALLOT_GENESIS.configHash, configHash: H(2), config: Uint8Array.of(2), activationHeight: 50 };
  const history = liveConfig({ genesis: BALLOT_GENESIS, passed: [later], height: 60 }).history;
  assert.equal(isRepeal({ config: Uint8Array.from(BALLOT_GENESIS.config) }, history), true);
});
