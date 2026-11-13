// kanban #1489 refute of fix:census:2 (c56a218af): the deposit is not bound to its proposer, and "the first kept stays".
// The honest proposer can post only after the deposit confirms (blockHash), so the deposit is public on the chain first.
// Any bonded node watching the donation set names that deposit in its own proposal first: the honest proposal is refused 409
// at that seat - paid for, never counted. Before the fix it was kept (spam); now the same gap censors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);
// kanban #2536 (stale test, after #2562 c6082c4bf): a deposit at or above BALLOT_BIND_HEIGHT commits to its proposer and its body
// ("ARN" 'D' OP_RETURN), as the honest proposer's wallet makes it. The squatter names the same txid in his own body.
const HONEST_CFG = 1;
const bodyOf = (secretByte, cfg, depositTxid) => ({ networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(cfg)),
  config: Uint8Array.of(cfg), class: CLASS.DESIGN, activationHeight: 208, proposer: schnorr.getPublicKey(new Uint8Array(32).fill(secretByte)), depositTxid });
const raw = tx([...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })),
  { sats: 0, script: depositCommitmentScript(bodyOf(1, HONEST_CFG, new Uint8Array(32))) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const display = toHex(Uint8Array.from(depositTxid).reverse());
const CENSUS = [{ pubkey: toHex(schnorr.getPublicKey(new Uint8Array(32).fill(1))) }, { pubkey: toHex(schnorr.getPublicKey(new Uint8Array(32).fill(9))) }];
const make = (secretByte, cfg) => {
  const secret = new Uint8Array(32).fill(secretByte);
  const p = bodyOf(secretByte, cfg, depositTxid);
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
};

test('a bonded node that names the honest proposer\'s confirmed deposit first does not get the honest proposal refused', async () => {
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === display ? { raw, height: 200 } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt: async () => CENSUS,
    store: { read: () => [], write: () => {} }, bindHeightFor: () => 0 });
  // the honest proposer (key 1) paid the deposit; the squatter (key 9) read it off the chain and posts first
  const squat = await seat.add({ proposal: make(9, 0xee), blockHash: BLOCK });
  console.log('  squatter on the honest deposit:', squat.status, squat.why || '');
  assert.notEqual(squat.status, 201, 'a deposit committed to the honest proposer backs the squatter');
  const honest = await seat.add({ proposal: make(1, HONEST_CFG), blockHash: BLOCK });
  console.log('  honest proposal on its own deposit:', honest.status, honest.why || '');
  assert.equal(honest.status, 201, `the proposer who paid the deposit is shut out: ${honest.why}`);
});
