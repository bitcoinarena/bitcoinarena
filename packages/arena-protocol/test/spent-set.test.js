// A HALTED FEDERATION'S SPENT-NOTE SET (spec §23A.5 liquidation step 1, kanban #323).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodeSpentSet, decodeSpentSet, signSpentSet, spentSetStands, newestSpentSet, spentNonceSet } from '../src/spent-set.js';
import { settleClaims, TESTNET_CLOCKS } from '../src/federation-slash.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const guardians = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, nodePubkey: schnorr.getPublicKey(secret) }; });
const record = { federationId: FED, threshold: 5, guardians: guardians.map(({ nodePubkey }) => ({ nodePubkey })) };
const nonce = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(i)]);
const copy = (g, session, ids) => signSpentSet({ federationId: FED, session, nonces: ids.map(nonce), signer: g.nodePubkey }, (m) => schnorr.sign(m, g.secret));

test('a copy is (federation, session, sorted nonces, signer) and reads back the same; one set has one encoding', () => {
  const c = copy(guardians[0], 40, [9, 3, 3, 7]);
  assert.deepEqual(c.nonces.map((n) => n[1]), [3, 7, 9], 'sorted and distinct when signed');
  const { signature, ...body } = c;
  assert.deepEqual(decodeSpentSet(encodeSpentSet(body)), body);
  assert.throws(() => encodeSpentSet({ ...body, nonces: [nonce(9), nonce(3)] }), /sorted and distinct/);
  assert.throws(() => encodeSpentSet({ ...body, nonces: [new Uint8Array(32)] }), /33-byte/);
  assert.equal(spentSetStands(c, { record, verify }).ok, true);
});

test('only a guardian of the record, over its own bytes, publishes a copy that stands', () => {
  const stranger = { secret: new Uint8Array(32).fill(0x99) }; stranger.nodePubkey = schnorr.getPublicKey(stranger.secret);
  assert.match(spentSetStands(copy(stranger, 40, [1]), { record, verify }).why, /not a guardian/);
  const c = copy(guardians[1], 40, [1, 2]);
  assert.match(spentSetStands({ ...c, nonces: [nonce(1)] }, { record, verify }).why, /not signed by its signer/);
  assert.match(spentSetStands({ ...c, federationId: new Uint8Array(32).fill(1) }, { record, verify }).why, /another federation/);
});

test('the newest session wins; one session in two versions keeps the one most guardians signed and names the split', () => {
  const p = newestSpentSet([copy(guardians[0], 40, [1, 2]), copy(guardians[1], 41, [1, 2, 3]), copy(guardians[2], 41, [1, 2, 3]),
    copy(guardians[3], 41, [1, 2, 3, 4])], { record, verify });
  assert.deepEqual([p.session, p.signers, p.disagree, p.copy.nonces.length], [41, 2, 1, 3]);
  const tie = newestSpentSet([copy(guardians[1], 41, [1, 2, 3]), copy(guardians[3], 41, [1, 2, 3, 4])], { record, verify });
  assert.equal(tie.copy.nonces.length, 3, 'a nonce not proven spent stays the player\'s');
  assert.equal(newestSpentSet([], { record, verify }).copy, null);
  assert.match(newestSpentSet([{ ...copy(guardians[0], 40, [1]), signature: new Uint8Array(64) }], { record, verify }).why, /no copy stands/);
});

test('the copy that counts is what settleClaims refuses spent notes by', () => {
  const p = newestSpentSet([copy(guardians[0], 41, [5])], { record, verify });
  const spentNonces = spentNonceSet(p.copy);
  const claims = [{ nonce: toHex(nonce(5)), amountMsat: 1000n, height: 10 }, { nonce: toHex(nonce(6)), amountMsat: 1000n, height: 10 }];
  const r = settleClaims({ escrowMsat: 10_000n, claims, spentNonces, haltHeight: 0, atHeight: 10, clocks: TESTNET_CLOCKS, noteSigned: () => true });
  assert.equal(r.paid.length, 1);
  assert.equal(r.refused.length, 1);
});
