// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census-1 (2026-11-27): the #1941 refind (ballot-tally.js followReorgs) looks for an orphaned proposal's deposit only
// from its OLD publication height upward (h = p.publishedAt .. +REFIND_SPAN). A reorg two blocks deep (fork below the publication
// block) re-mines the deposit in the winning branch's block ONE BELOW the old publication height - the deposit was in the mempool when
// that branch's miner built it. That block is never asked, so the proposal stays ORPHANED for good at every seat (the pull hands only
// the old hash), deposit paid and confirmed on the chain the seat follows.
// Safe behaviour: a proposal whose deposit is confirmed on this seat's chain is counted from the block that holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals, stateOf } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const h64 = (tag, h) => (tag + h.toString(16).padStart(6, '0')).padEnd(64, '0');

test('wf1489 sm1 census-1: a deposit re-mined BELOW its old publication height by a 2-deep reorg leaves its proposal orphaned for good', async () => {
  const raw = tx(depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const secret = new Uint8Array(32).fill(1);
  const proposer = schnorr.getPublicKey(secret);
  // THE CHAIN: blocks by height; the deposit sits in the block `depositAt` names
  const chain = { tip: 203, hashes: new Map(), depositAt: 200 };
  for (let h = 0; h <= 400; h++) chain.hashes.set(h, h64('aa', h));
  const confirmedTx = async (txid, block) => {
    const h = [...chain.hashes].find(([hh, x]) => x === block && hh <= chain.tip);
    return h && h[0] === chain.depositAt && txid === display ? { raw, height: h[0] } : null;
  };
  const censusAt = async () => [{ pubkey: proposer, outpoint: 'aa:0', bondSats: 100000n }];
  const seat = createProposals({ confirmedTx, recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    repealSchedule: REPEAL_SCHEDULES.regtest, censusAt, store: { read: () => [], write: () => {} } });
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(Uint8Array.of(7)), config: Uint8Array.of(7),
    class: CLASS.DESIGN, activationHeight: 230, proposer, depositTxid };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  const got = await seat.add({ proposal: hex, blockHash: chain.hashes.get(200) });
  assert.equal(got.status, 201, got.why);
  const tally = createBallotTally({ proposals: seat, tipHeight: async () => chain.tip, votesAt: async () => [], censusAt, verify,
    blockHashAt: async (h) => (h <= chain.tip ? chain.hashes.get(h) : null), decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  await tally.pass();
  assert.equal(stateOf(seat.list()[0]), 'COUNTING');

  // THE REORG, TWO DEEP: another branch from 199 up, and its 199 holds the deposit (old 199 did not, old 200 did)
  for (let h = 199; h <= 400; h++) chain.hashes.set(h, h64('bb', h));
  chain.depositAt = 199;
  chain.tip = 204;
  for (let i = 0; i < 6; i++) {
    await tally.pass();
    // the peer pull: every other seat orphaned it alike and hands the record it holds
    await seat.pull(seat.list().map((r) => ({ id: r.id, proposal: r.proposal, blockHash: r.blockHash })));
    chain.tip++;
  }
  const r = seat.list()[0];
  const onChain = await confirmedTx(display, chain.hashes.get(199));
  console.log('  deposit on this chain at', onChain && onChain.height, '; proposal state:', stateOf(r), '; phase:', tally.list()[0].phase,
    '; orphaned:', JSON.stringify(r.orphaned || null));
  // CONTROL: the same proposal posted to a fresh seat naming the block that holds it now is taken - it stands from 199
  const fresh = createProposals({ confirmedTx, recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    repealSchedule: REPEAL_SCHEDULES.regtest, censusAt, store: { read: () => [], write: () => {} } });
  const ctl = await fresh.add({ proposal: hex, blockHash: chain.hashes.get(199) }, { own: true });
  console.log('  control: posted naming the new block 199 ->', ctl.status, ctl.why || '');
  assert.equal(ctl.status, 201, 'control: the proposal stands from the block that holds its deposit now');
  assert.ok(onChain, 'the deposit is confirmed on the chain the seat follows');
  assert.notEqual(stateOf(r), 'ORPHANED',
    'its deposit is confirmed in block 199 of this chain, yet the proposal stays ORPHANED ("its publication block left this chain") and is never counted');
});
