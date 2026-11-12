// kanban #1670 (after #1489 census-3): every record kept before a start is held to the census at its publication height again: a bonded one comes back as stored, an unbonded one is kept ORPHANED (unbonded), never restored by the tally, never deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs, tag = 7) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(tag), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);
const BLOCK2 = 'cc'.repeat(32);

function setup({ census, tag = 7, blocks = [BLOCK], store } = {}) {
  const raw = tx(depositOutputsExpected(1, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), tag);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const seat = createProposals({ confirmedTx: async (txid, block) => (blocks.includes(block) && txid === display ? { raw, height: 200 } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt: census,
    store: store || { read: () => [], write: () => {} } });
  return { seat, depositTxid };
}
const proposalHex = (secret, depositTxid) => {
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(7)), config: Uint8Array.of(7),
    class: CLASS.MONEY, activationHeight: 208, proposer: schnorr.getPublicKey(secret), depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
};
const bondedSecret = new Uint8Array(32).fill(1);
const bondedX = schnorr.getPublicKey(bondedSecret);
const stranger = new Uint8Array(32).fill(9);


const keptBy = async (secret) => {
  const pre = setup({ census: async () => [{ pubkey: schnorr.getPublicKey(secret) }] });
  await pre.seat.add({ proposal: proposalHex(secret, pre.depositTxid), blockHash: BLOCK });
  return pre.seat.list()[0];
};
const settle = () => new Promise((r) => setImmediate(r));

test('a bonded PASSED record comes back as it was stored, its outcome kept, nothing written', async () => {
  const rec = { ...(await keptBy(bondedSecret)), state: 'PASSED', decided: { passed: true, decidedAt: 210, anchor: null } };
  const writes = [];
  const seat = setup({ census: async () => [{ pubkey: bondedX }], store: { read: () => [rec], write: (l) => writes.push(l) } }).seat;
  assert.equal(seat.list()[0].state, 'ORPHANED');              // not checked yet: counted for nothing, its outcome not live
  assert.equal(seat.unchecked(), 1);
  assert.equal(seat.restore(rec.id), false);                   // the tally's restore does not take it back unchecked
  await settle(); await seat.recheck();
  assert.equal(seat.unchecked(), 0);
  assert.deepEqual(seat.list()[0], rec);
  assert.equal(writes.length, 0);
});

test('an unbonded record is written ORPHANED (unbonded) with its bytes and outcome, and the tally cannot restore it', async () => {
  const rec = { ...(await keptBy(stranger)), state: 'PASSED', decided: { passed: true, decidedAt: 210, anchor: null } };
  const writes = [];
  const seat = setup({ census: async () => [{ pubkey: bondedX }], store: { read: () => [rec], write: (l) => writes.push(l) } }).seat;
  await settle(); await seat.recheck();
  const r = seat.list()[0];
  assert.equal(r.state, 'ORPHANED');
  assert.equal(r.orphaned.unbonded, true);
  assert.equal(r.orphaned.was, 'PASSED');
  assert.deepEqual(r.orphaned.outcome, rec.decided);
  assert.equal(r.proposal, rec.proposal);
  assert.equal(seat.restore(r.id), false);
  assert.ok(writes.length >= 1 && writes.at(-1).length === 1 && writes.at(-1)[0].orphaned.unbonded === true);
  // the next start reads it unbonded again, still not COUNTING
  const again = setup({ census: async () => [{ pubkey: bondedX }], store: { read: () => [writes.at(-1)[0]], write: () => {} } }).seat;
  await settle(); await again.recheck();
  assert.equal(again.list()[0].state, 'ORPHANED');
  assert.equal(again.restore(r.id), false);
});

test('a census not readable yet keeps the record unchecked until it is', async () => {
  const rec = await keptBy(bondedSecret);
  let ready = false;
  const seat = setup({ census: async () => (ready ? [{ pubkey: bondedX }] : null), store: { read: () => [rec], write: () => {} } }).seat;
  await settle(); await seat.recheck();
  assert.equal(seat.list()[0].state, 'ORPHANED');
  assert.equal(seat.unchecked(rec.networkId), 1);
  ready = true; await seat.recheck();
  assert.equal(seat.list()[0].state, 'COUNTING');
});

test('no census reader given: records load as stored (the behaviour before #1489)', async () => {
  const rec = await keptBy(stranger);
  const seat = setup({ census: null, store: { read: () => [rec], write: () => {} } }).seat;
  assert.equal(seat.list()[0].state, 'COUNTING');
});
