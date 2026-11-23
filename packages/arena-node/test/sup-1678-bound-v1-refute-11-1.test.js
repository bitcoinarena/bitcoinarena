// kanban #1489 refute of fix:census:2 (c56a218af): "the first kept stays" is SEAT-LOCAL. Two proposals naming one deposit,
// each posted to a different seat, never meet: the peer pull refuses the other with 409 at each seat. Two seats then hold and
// tally different proposals for the same ballot - their live configs can split (before the fix both seats kept both).
// Adapted to 1.9 by #2536 (kanban #1678): every deposit is BOUND (#2125 / #2012, c6082c4bf; regtest and mainnet from block 0,
// server.js bindHeightFor): it commits to its proposer key and the proposal's bytes, so the proposal that is not the deposit's own
// is refused at EVERY seat (422), in whatever order the seats hear the two - the same attack, both seats end on the same set.
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
const body = (secretByte, cfg) => ({ networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(cfg)),
  config: Uint8Array.of(cfg), class: CLASS.DESIGN, activationHeight: 208, proposer: schnorr.getPublicKey(new Uint8Array(32).fill(secretByte)) });
// the deposit is proposer 1's, committed to its config-1 proposal
const raw = tx([...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body(1, 1)) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const display = toHex(Uint8Array.from(depositTxid).reverse());
// both proposers are bonded nodes in the census
const CENSUS = [{ pubkey: toHex(schnorr.getPublicKey(new Uint8Array(32).fill(1))) }, { pubkey: toHex(schnorr.getPublicKey(new Uint8Array(32).fill(9))) }];
const seat = () => createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === display ? { raw, height: 200 } : null),
  recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt: async () => CENSUS,
  bindHeightFor: () => 0, store: { read: () => [], write: () => {} } });
const make = (secretByte, cfg) => {
  const p = { ...body(secretByte, cfg), depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), new Uint8Array(32).fill(secretByte))]));
};

for (const [name, other] of [['another bonded proposer', [9, 2]], ['the same proposer with another config', [1, 2]]]) {
  test(`two seats hear two proposals on one bound deposit in opposite order (${name}): after the peer pull they keep the same proposals`, async () => {
    const a = seat(); const b = seat();
    const p1 = make(1, 1); const p2 = make(...other);
    assert.equal((await a.add({ proposal: p1, blockHash: BLOCK })).status, 201);
    const r2 = await b.add({ proposal: p2, blockHash: BLOCK });
    console.log('  seat B on the other proposal:', r2.status, r2.why);
    assert.equal(r2.status, 422, 'a proposal the deposit is not committed to is refused at the door');
    // the peer pull (server.js pullProposals -> proposals.pull) both ways, twice
    for (let i = 0; i < 2; i++) { await a.pull(b.list()); await b.pull(a.list()); }
    const ids = (s) => s.list().map((r) => r.id).sort().join(',');
    console.log('  seat A keeps', ids(a), '\n  seat B keeps', ids(b));
    assert.equal(ids(a), ids(b), 'two seats tally different proposals for one deposit: their ballots (and live configs) split');
    assert.equal(a.list().length, 1);
    assert.ok(a.counts(a.list()[0].id) && b.counts(b.list()[0].id), 'the deposit\'s own proposal counts at both seats');
  });
}
