// kanban #1489 round 2: one committee seat answering GET /round-result with the honest prices and a one-character
// signature must not stop the page from showing the result the other six seats signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { roundVerdict } from '../src/round-verdict.js';
import { roundResultId, frontOf } from '../../arena-protocol/src/round-result.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('one seat out of 7 with a malformed signature does not break the verdict the other 6 signed', async () => {
  const roundId = new Uint8Array(32).fill(7);
  const openCents = 8297000, closeCents = 8300500;
  const id = roundResultId({ roundId, openCents, closeCents, front: frontOf(openCents, closeCents) });
  const secrets = [1, 2, 3, 4, 5, 6, 7].map((i) => new Uint8Array(32).fill(i));
  const keys = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
  const answers = secrets.map((s, i) => ({ openCents, closeCents, key: keys[i], signature: toHex(schnorr.sign(id, s)) }));
  // seat 0 (a committee member) answers the same prices with a 1-hex-char signature
  answers[0] = { openCents, closeCents, key: keys[0], signature: 'a' };
  const fetcher = async (url) => {
    const i = Number(/^seat(\d)\//.exec(url)[1]);
    return { ok: true, status: 200, json: async () => answers[i], text: async () => '' };
  };
  let v;
  try {
    v = await roundVerdict({ roundId, nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => `seat${i}`), committee: keys,
      verify: (sg, m, k) => schnorr.verify(sg, m, k), fetcher });
  } catch (e) { assert.fail(`roundVerdict threw on one seat's answer: ${e.message}`); }
  assert.equal(v.ok, true, v.why);
  assert.equal(v.front, 'BULLS');
  assert.equal(v.signers, 6);
});
