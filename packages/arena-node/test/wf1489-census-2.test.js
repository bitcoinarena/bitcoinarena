// kanban #1489: one proposal deposit (spent to the donation set, the rate limit of 27A.7.2) backs any number of proposals - also
// proposals of another proposer naming someone else's deposit transaction.
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
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);

test('one deposit transaction backs one proposal: the same deposit_txid named again (other config, other proposer) is refused', async () => {
  const BLOCK = 'bb'.repeat(32);
  const raw = tx(depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === display ? { raw, height: 200 } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, store: { read: () => [], write: () => {} } });
  const make = (secretByte, cfg) => {
    const secret = new Uint8Array(32).fill(secretByte);
    const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(cfg)), config: Uint8Array.of(cfg),
      class: CLASS.DESIGN, activationHeight: 208, proposer: schnorr.getPublicKey(secret), depositTxid };
    return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  };
  const honest = await seat.add({ proposal: make(1, 1), blockHash: BLOCK });
  assert.equal(honest.status, 201, honest.why);
  let free = 0;
  for (let i = 2; i < 52; i++) {                                    // the attacker's 50 proposals, not one sat paid by him
    const got = await seat.add({ proposal: make(9, i), blockHash: BLOCK });
    if (got.ok && got.status === 201) free++;
  }
  console.log('  KEPT on one deposit:', seat.list().length, 'proposals; free ones:', free);
  assert.equal(free, 0, 'a deposit already backing a proposal backs no other');
  assert.equal(seat.list().length, 1);
});
