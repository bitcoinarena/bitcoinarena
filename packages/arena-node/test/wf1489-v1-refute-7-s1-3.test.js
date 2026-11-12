// kanban #1489 v1-refute-7: probes of the census-3 fix (only a bonded node may publish a config proposal, 27A.7.2).
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

test('V1 peer pull of an unbonded proposal is not taken', async () => {
  const { seat, depositTxid } = setup({ census: async () => [{ pubkey: bondedX, bondSats: 100000n }] });
  const took = await seat.pull([{ id: 'x', proposal: proposalHex(stranger, depositTxid), blockHash: BLOCK }]);
  console.log('  PULL took', took, 'list', seat.list().length);
  assert.equal(took, 0); assert.equal(seat.list().length, 0);
});

test('V2 census keys as 33-byte prefixed (02/03), hex strings, upper case: stranger refused, bonded taken', async () => {
  for (const form of [(k) => Uint8Array.from([0x03, ...k]), (k) => toHex(Uint8Array.from([0x02, ...k])).toUpperCase(), (k) => toHex(k)]) {
    const s1 = setup({ census: async () => [{ pubkey: form(bondedX) }, null, {}, { pubkey: '' }] });
    const bad = await s1.seat.add({ proposal: proposalHex(stranger, s1.depositTxid), blockHash: BLOCK });
    const s2 = setup({ census: async () => [{ pubkey: form(bondedX) }] });
    const good = await s2.seat.add({ proposal: proposalHex(bondedSecret, s2.depositTxid), blockHash: BLOCK });
    console.log('  form', bad.status, good.status);
    assert.equal(bad.ok, false); assert.equal(good.status, 201);
  }
});

test('V3 census read fails / is empty / not an array: no proposal kept', async () => {
  for (const census of [async () => { throw new Error('rpc'); }, async () => null, async () => [], async () => ({ length: 1, 0: { pubkey: toHex(schnorr.getPublicKey(stranger)) } })]) {
    const { seat, depositTxid } = setup({ census });
    const got = await seat.add({ proposal: proposalHex(stranger, depositTxid), blockHash: BLOCK });
    console.log('  census edge', got.status);
    assert.equal(got.ok, false);
  }
});

test('V4 orphaned record re-posted from a new block is checked against the census again', async () => {
  // a record kept (e.g. before the fix) and orphaned, then named from another block
  const pre = setup({ census: async () => [{ pubkey: schnorr.getPublicKey(stranger) }], blocks: [BLOCK, BLOCK2] });
  const first = await pre.seat.add({ proposal: proposalHex(stranger, pre.depositTxid), blockHash: BLOCK });
  assert.equal(first.status, 201);
  const rec = { ...pre.seat.list()[0] };
  const orphaned = { ...rec, state: 'ORPHANED', orphaned: { at: 201, why: 'reorg', was: 'COUNTING' } };
  const seat2 = setup({ census: async () => [{ pubkey: bondedX }], blocks: [BLOCK, BLOCK2], store: { read: () => [orphaned], write: () => {} } });
  const again = await seat2.seat.add({ proposal: rec.proposal, blockHash: BLOCK2 });
  console.log('  re-post of orphaned unbonded', again.status, again.why);
  assert.equal(again.ok, false);
});

test('V5 a COUNTING record of an unbonded proposer kept before the fix is still served and counted after the upgrade', async () => {
  const pre = setup({ census: async () => [{ pubkey: schnorr.getPublicKey(stranger) }] });   // stand-in for a pre-fix seat
  await pre.seat.add({ proposal: proposalHex(stranger, pre.depositTxid), blockHash: BLOCK });
  const rec = pre.seat.list()[0];
  const seat2 = setup({ census: async () => [{ pubkey: bondedX }], store: { read: () => [rec], write: () => {} } });
  const kept = seat2.seat.list().filter((r) => r.state === 'COUNTING');
  console.log('  pre-fix unbonded record after restart:', kept.length ? kept[0].state : 'gone');
  assert.equal(kept.length, 0, 'a stored proposal of an unbonded proposer is still COUNTING after the upgrade');
});
