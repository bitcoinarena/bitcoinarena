// kanban #1489: spec 27A.7.2 "proposer: node pubkey with an active bond" - a seat keeps a proposal from a key no bond stands behind.
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
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);

test('a proposal whose proposer holds no active bond at its publication is refused (27A.7.2)', async () => {
  const BLOCK = 'bb'.repeat(32);
  const raw = tx(depositOutputsExpected(1, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })));   // 1 sat deposit
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const bonded = schnorr.getPublicKey(new Uint8Array(32).fill(1));
  // the census at the publication height: one bonded node, and the proposer below is not it
  const censusAt = async () => [{ pubkey: bonded, outpoint: 'aa:0', bondSats: 100000n }];
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === display ? { raw, height: 200 } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt,
    store: { read: () => [], write: () => {} } });
  const secret = new Uint8Array(32).fill(9);                        // a fresh key, never bonded
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(7)), config: Uint8Array.of(7),
    class: CLASS.MONEY, activationHeight: 208, proposer: schnorr.getPublicKey(secret), depositTxid };
  const got = await seat.add({ proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)])), blockHash: BLOCK });
  console.log('  UNBONDED PROPOSER:', got.status, got.why || 'kept');
  assert.equal(got.ok, false, 'a key with no bond in the census at publication may not propose');
});
