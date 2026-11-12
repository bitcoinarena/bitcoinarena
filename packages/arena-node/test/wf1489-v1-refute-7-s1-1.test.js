// kanban #1489 v1-refute-7: census-3 fix: a proposal of an unbonded proposer kept before the upgrade stays COUNTING (never re-checked on load or in the tally).
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

test('V5 a COUNTING record of an unbonded proposer kept before the fix is still served and counted after the upgrade', async () => {
  const pre = setup({ census: async () => [{ pubkey: schnorr.getPublicKey(stranger) }] });   // stand-in for a pre-fix seat
  await pre.seat.add({ proposal: proposalHex(stranger, pre.depositTxid), blockHash: BLOCK });
  const rec = pre.seat.list()[0];
  const seat2 = setup({ census: async () => [{ pubkey: bondedX }], store: { read: () => [rec], write: () => {} } });
  const kept = seat2.seat.list().filter((r) => r.state === 'COUNTING');
  console.log('  pre-fix unbonded record after restart:', kept.length ? kept[0].state : 'gone');
  assert.equal(kept.length, 0, 'a stored proposal of an unbonded proposer is still COUNTING after the upgrade');
});
