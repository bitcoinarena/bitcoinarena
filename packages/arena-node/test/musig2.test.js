// MUSIG2 HELD TO BIP-327'S PUBLISHED VECTORS (kanban #307; test-vectors/bip327, fetched from bitcoin/bips bip-0327/vectors):
// key sort, key aggregation with its errors, x-only and plain tweaks, nonce generation and aggregation with their errors,
// signing and partial-signature verification with their failures, and signature aggregation. Then the bond's own key
// path: the node and the 7 regtest arbitration members sign as one, nested, and the aggregate verifies under the bond's
// output key bond-script.js builds - with one member missing it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keySort, keyAgg, applyTweak, xonlyOf, nonceGen, nonceAgg, sign, partialSigVerify, partialSigAgg, MusigError,
  bondSigningContext, bondPartialSign, bondNonceAgg, bondSignatureAgg } from '../src/musig2.js';
import { bondOutputKey, bondInternalKey, bondTapTree } from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { taggedHash } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

const V = (f) => JSON.parse(readFileSync(new URL(`../../../test-vectors/bip327/${f}.json`, import.meta.url), 'utf8'));
const h = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const H = (b) => Buffer.from(b).toString('hex').toUpperCase();
const ctxWith = (pks, tweaks = [], xonly = []) => tweaks.reduce((c, t, i) => applyTweak(c, t, xonly[i]), keyAgg(pks));
const throwsMusig = (fn, want) => {
  try { fn(); } catch (e) {
    if (want && want.type === 'invalid_contribution') { assert.ok(e instanceof MusigError, e.message); assert.equal(e.signer, want.signer); return; }
    return;
  }
  assert.fail('expected an error');
};

test('KeySort and KeyAgg match the BIP-327 vectors, and refuse an invalid key or tweak by its signer', () => {
  const ks = V('key_sort_vectors');
  assert.deepEqual(keySort(ks.pubkeys.map(h)).map(H), ks.sorted_pubkeys);
  const v = V('key_agg_vectors');
  for (const c of v.valid_test_cases) assert.equal(H(xonlyOf(keyAgg(c.key_indices.map((i) => h(v.pubkeys[i]))))), c.expected);
  for (const c of v.error_test_cases)
    throwsMusig(() => ctxWith(c.key_indices.map((i) => h(v.pubkeys[i])), c.tweak_indices.map((i) => h(v.tweaks[i])), c.is_xonly), c.error);
});

test('NonceGen and NonceAgg match the BIP-327 vectors', () => {
  for (const c of V('nonce_gen_vectors').test_cases) {
    const got = nonceGen({ rand: h(c.rand_), sk: c.sk ? h(c.sk) : null, pk: h(c.pk), aggpk: c.aggpk ? h(c.aggpk) : null,
      msg: c.msg === null ? null : h(c.msg), extraIn: c.extra_in ? h(c.extra_in) : null });
    assert.equal(H(got.secnonce), c.expected_secnonce);
    assert.equal(H(got.pubnonce), c.expected_pubnonce);
  }
  const v = V('nonce_agg_vectors');
  for (const c of v.valid_test_cases) assert.equal(H(nonceAgg(c.pnonce_indices.map((i) => h(v.pnonces[i])))), c.expected);
  for (const c of v.error_test_cases) throwsMusig(() => nonceAgg(c.pnonce_indices.map((i) => h(v.pnonces[i]))), c.error);
});

test('Sign and PartialSigVerify match the BIP-327 vectors; a wrong partial signature fails', () => {
  const v = V('sign_verify_vectors');
  const sk = h(v.sk);
  for (const c of v.valid_test_cases) {
    const pks = c.key_indices.map((i) => h(v.pubkeys[i]));
    const ctx = keyAgg(pks);
    const psig = sign(h(v.secnonces[0]), sk, ctx, h(v.aggnonces[c.aggnonce_index]), h(v.msgs[c.msg_index]));
    assert.equal(H(psig), c.expected, c.comment || '');
    assert.equal(partialSigVerify(psig, c.nonce_indices.map((i) => h(v.pnonces[i])), ctx, h(v.msgs[c.msg_index]), c.signer_index), true);
  }
  for (const c of v.verify_fail_test_cases)
    assert.equal(partialSigVerify(h(c.sig), c.nonce_indices.map((i) => h(v.pnonces[i])), keyAgg(c.key_indices.map((i) => h(v.pubkeys[i]))), h(v.msgs[c.msg_index]), c.signer_index), false, c.comment);
  for (const c of v.sign_error_test_cases)
    throwsMusig(() => sign(h(v.secnonces[c.secnonce_index]), sk, keyAgg(c.key_indices.map((i) => h(v.pubkeys[i]))), h(v.aggnonces[c.aggnonce_index]), h(v.msgs[c.msg_index])), c.error);
});

test('tweaks (x-only and plain) and PartialSigAgg match the BIP-327 vectors', () => {
  const t = V('tweak_vectors');
  for (const c of t.valid_test_cases) {
    const ctx = ctxWith(c.key_indices.map((i) => h(t.pubkeys[i])), c.tweak_indices.map((i) => h(t.tweaks[i])), c.is_xonly);
    assert.equal(H(sign(h(t.secnonce), h(t.sk), ctx, h(t.aggnonce), h(t.msg))), c.expected, c.comment);
  }
  for (const c of t.error_test_cases)
    throwsMusig(() => ctxWith(c.key_indices.map((i) => h(t.pubkeys[i])), c.tweak_indices.map((i) => h(t.tweaks[i])), c.is_xonly), c.error);
  const a = V('sig_agg_vectors');
  for (const c of a.valid_test_cases) {
    const ctx = ctxWith(c.key_indices.map((i) => h(a.pubkeys[i])), c.tweak_indices.map((i) => h(a.tweaks[i])), c.is_xonly);
    const sig = partialSigAgg(c.psig_indices.map((i) => h(a.psigs[i])), ctx, h(c.aggnonce), h(a.msg));
    assert.equal(H(sig), c.expected);
    assert.equal(schnorr.verify(sig, h(a.msg), xonlyOf(ctx)), true);
  }
  for (const c of a.error_test_cases) {
    const ctx = ctxWith(c.key_indices.map((i) => h(a.pubkeys[i])), c.tweak_indices.map((i) => h(a.tweaks[i])), c.is_xonly);
    throwsMusig(() => partialSigAgg(c.psig_indices.map((i) => h(a.psigs[i])), ctx, h(c.aggnonce), h(a.msg)), c.error);
  }
});

test('the bond\'s key path: the node and the 7 arbitration members sign as one under the bond\'s output key; six members do not', () => {
  const g = genesisFor('regtest');
  const members = Array.from({ length: g.arbitrationM }, (_, i) => taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`)));
  const byKey = new Map(members.map((s) => [Buffer.from(schnorr.getPublicKey(s)).toString('hex'), s]));
  const nodeSk = taggedHash('ARENA/test/musig-node', new Uint8Array([1]));
  const nodeKey = schnorr.getPublicKey(nodeSk);
  // the bond as bond-script.js builds it: its output key, its tree's tweak
  const internal = bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey;
  const inputs = { nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: 300, internalKey: internal };
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  const tree = bondTapTree(inputs, { combine });
  const bctx = bondSigningContext({ nodeKey, arbitrationKeys: g.arbitrationKeys, tweak: tree.tweak });
  assert.equal(H(bctx.internalKey), H(internal), 'the same internal key bond-script.js derives');
  assert.equal(H(bctx.outputKey), H(built.outputKey), 'the same output key the bond pays');
  const msg = taggedHash('ARENA/test/musig-msg', new Uint8Array([7]));
  const run = (who) => {
    const nonces = who.map((w) => nonceGen({ pk: w === 'node' ? Uint8Array.from([2, ...nodeKey]) : Uint8Array.from([2, ...bctx.inner.pks[w]]) }));
    const aggnonce = bondNonceAgg({ node: nonces[0].pubnonce, members: nonces.slice(1).map((x) => x.pubnonce) });
    const psigs = who.map((w, i) => bondPartialSign(bctx, { who: w, sk: w === 'node' ? nodeSk : byKey.get(Buffer.from(bctx.inner.pks[w]).toString('hex')),
      secnonce: nonces[i].secnonce, aggnonce, msg }));
    return { psigs, aggnonce };
  };
  const all = run(['node', 0, 1, 2, 3, 4, 5, 6]);
  const sig = bondSignatureAgg(bctx, { psigs: all.psigs, aggnonce: all.aggnonce, msg });
  assert.equal(schnorr.verify(sig, msg, built.outputKey), true, 'one BIP-340 signature under the bond\'s output key');
  const six = run(['node', 0, 1, 2, 3, 4, 5]);
  assert.throws(() => bondSignatureAgg(bctx, { psigs: six.psigs, aggnonce: six.aggnonce, msg }), /does not verify under the bond's output key/);
});
