// kanban #1489 v1-refute-7: variants against the census-3 fix (only a bonded node proposes, 27A.7.2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs, salt = 7) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(salt), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32), BLOCK2 = 'cc'.repeat(32);

function mk(secretByte, { sats = 1, salt = 7 } = {}) {
  const raw = tx(depositOutputsExpected(sats, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), salt);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const secret = new Uint8Array(32).fill(secretByte);
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(7)), config: Uint8Array.of(7),
    class: CLASS.MONEY, activationHeight: 208, proposer: schnorr.getPublicKey(secret), depositTxid };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  return { raw, display, hex, proposer: p.proposer };
}
const seatWith = (censusAt, deps, store = { read: () => [], write: () => {} }) => createProposals({
  confirmedTx: async (txid, block) => { const d = deps.find((x) => x.display === txid && (x.blocks || [BLOCK]).includes(block)); return d ? { raw: d.raw, height: 200 } : null; },
  recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt, store });

test('honest: bonded proposer kept (x-only Uint8Array, 33-byte Buffer, upper-case 66-hex string)', async () => {
  const a = mk(1);
  const bondedX = schnorr.getPublicKey(new Uint8Array(32).fill(1));
  for (const pub of [bondedX, Buffer.from([0x03, ...bondedX]), ('02' + toHex(bondedX)).toUpperCase()]) {
    const got = await seatWith(async () => [{ pubkey: pub, bondSats: 100000n }], [a]).add({ proposal: a.hex, blockHash: BLOCK });
    assert.equal(got.status, 201, `${typeof pub}: ${got.why}`);
  }
});
test('census asked at the deposit height, on the proposal network', async () => {
  const a = mk(1); let asked = null;
  await seatWith(async (n, h) => { asked = [n, h]; return [{ pubkey: a.proposer }]; }, [a]).add({ proposal: a.hex, blockHash: BLOCK });
  assert.deepEqual(asked, [toHex(NET), 200]);
});
test('unbonded: empty census, census null, census throws, census non-array, entries without pubkey', async () => {
  const a = mk(9);
  for (const [c, want] of [[async () => [], 422], [async () => null, 503], [async () => { throw new Error('x'); }, 503], [async () => ({ length: 1, 0: { pubkey: a.proposer } }), 503],
    [async () => [null, {}, { pubkey: null }, { pubkey: '' }], 422]]) {
    const got = await seatWith(c, [a]).add({ proposal: a.hex, blockHash: BLOCK });
    assert.equal(got.ok, false); assert.equal(got.status, want, got.why);
  }
});
test('unbonded: a larger deposit does not buy the door; prefix-only / truncated key match refused', async () => {
  const a = mk(9, { sats: 5_000_000, salt: 8 });
  const x = toHex(a.proposer);
  for (const census of [[{ pubkey: x.slice(0, 62) }], [{ pubkey: '02' + x.slice(2) }], [{ pubkey: x + '00' }]]) {
    const got = await seatWith(async () => census, [a]).add({ proposal: a.hex, blockHash: BLOCK });
    assert.equal(got.ok, false, JSON.stringify(census));
  }
});
test('peer pull of an unbonded proposal takes nothing; orphan re-post path is checked again', async () => {
  const a = mk(9); a.blocks = [BLOCK, BLOCK2];
  const seat = seatWith(async () => [{ pubkey: schnorr.getPublicKey(new Uint8Array(32).fill(1)) }], [a]);
  assert.equal(await seat.pull([{ id: 'ff'.repeat(32), proposal: a.hex, blockHash: BLOCK }]), 0);
  assert.equal(seat.list().length, 0);
  // orphaned record of an unbonded proposer posted from a new block
  let bonded = true; const b = mk(9, { salt: 9 }); b.blocks = [BLOCK, BLOCK2];
  const s2 = seatWith(async () => (bonded ? [{ pubkey: b.proposer }] : []), [b]);
  const k = await s2.add({ proposal: b.hex, blockHash: BLOCK }); assert.equal(k.status, 201);
  assert.ok(s2.orphan(k.id));
  bonded = false;
  const again = await s2.add({ proposal: b.hex, blockHash: BLOCK2 });
  assert.equal(again.ok, false, 'orphan re-post from a block where the proposer has no bond must be checked');
});
