// THE BALLOT READ OFF THE CHAIN, ACTIVATION AND REPEAL (spec §27A.7.3, §27A.7.5-6, kanban #329).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { votesInBlock, liveConfig } from '../src/ballot-chain.js';
import { encodeVote, voteMessage, decodeVote, CHOICE, CLASS, proposalStands, proposalBodyId, isRepeal, SCHEDULES, REPEAL_SCHEDULES } from '../src/ballot.js';
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
    const p = { networkId: H(0x10), parent: H(2), configHash: H(config[0]), config, class: CLASS.MONEY, activationHeight, proposer, depositTxid: H(0x77) };
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
