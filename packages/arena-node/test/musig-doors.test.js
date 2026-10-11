// THE COOPERATIVE KEY PATH OVER THE DOORS (kanban #307, spec 5A.3B key path: MuSig2(node_key, arbitration_aggregate_key)).
// A seat's owner asks its node for its half (POST /owner/musig/nonce, /owner/musig/partial - signed by the owner), the
// arbiter's 7 members give theirs (POST /musig/nonce, /musig/partial), and a coordinator aggregates: one BIP-340 signature
// that verifies under the bond's output key - the key bond-script.js builds from that node and the network's set. A
// stranger cannot open a session at the seat, a nonce signs once, and the arbitration set signs only what its policy allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { arbitrationMembers, serveArbiter } from '../src/arbiter.js';
import { bondSigningContext, bondNonceAgg, bondSignatureAgg } from '../src/musig2.js';
import { bondOutputKey, bondInternalKey, bondTapTree } from '../../arena-protocol/src/bond-script.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

const set = arbitrationMembers('regtest');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a seat and the arbitration set sign the bond\'s key path together; one signature under the bond\'s output key', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const seat = await serve(openStore(), { plugins: [], port: 0, chain: 'bitcoin-regtest', owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  let allowed = true;
  const arb = await serveArbiter({ set, allow: () => (allowed ? { ok: true } : { ok: false, why: 'a proof against this node is open' }) });
  try {
    const S = `http://127.0.0.1:${seat.port}`, A = `http://127.0.0.1:${arb.port}`;
    const node = (await (await fetch(`${S}/owner`)).json()).node;
    const nodeKey = fromHex(node);
    const signed = (args, s = secret) => signOwnerRequest({ node, action: 'musig', args, secret: s, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    // THE BOND, as bond-script.js builds it for this node at a template-2 height
    const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
    const inputs = { nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: 1300, internalKey };
    const built = bondOutputKey(inputs, { tweakPoint, combine });
    const tweak = bondTapTree(inputs, { combine }).tweak;
    const msg = new Uint8Array(32).fill(0x5c);
    const session = { sessionId: 's1', tweak: toHex(tweak), msg: toHex(msg) };

    // a stranger cannot open the node's half
    assert.equal((await post(`${S}/owner/musig/nonce`, signed(session, ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403);
    const n1 = await (await post(`${S}/owner/musig/nonce`, signed(session))).json();
    assert.equal(n1.ok, true, n1.why);
    const a1 = await (await post(`${A}/musig/nonce`, { sessionId: 's1', nodeKey: node, tweak: toHex(tweak), msg: toHex(msg) })).json();
    assert.equal(a1.ok, true, a1.why);
    assert.equal(a1.pubnonces.length, 7);
    assert.equal(a1.outputKey, toHex(built.outputKey), 'the arbiter names the same output key');
    const aggnonce = bondNonceAgg({ node: fromHex(n1.pubnonce), members: a1.pubnonces.map((p) => fromHex(p.pubnonce)) });
    const p1 = await (await post(`${S}/owner/musig/partial`, signed({ sessionId: 's1', aggnonce: toHex(aggnonce) }))).json();
    const a2 = await (await post(`${A}/musig/partial`, { sessionId: 's1', aggnonce: toHex(aggnonce) })).json();
    assert.equal(p1.ok && a2.ok, true, p1.why || a2.why);
    const bctx = bondSigningContext({ nodeKey, arbitrationKeys: set.keys, tweak });
    const sig = bondSignatureAgg(bctx, { psigs: [fromHex(p1.psig), ...a2.psigs.map((p) => fromHex(p.psig))], aggnonce, msg });
    assert.equal(schnorr.verify(sig, msg, built.outputKey), true, 'one signature, under the bond\'s output key');

    // a nonce signs once
    assert.equal((await post(`${S}/owner/musig/partial`, signed({ sessionId: 's1', aggnonce: toHex(aggnonce) }))).status, 404);
    assert.equal((await post(`${A}/musig/partial`, { sessionId: 's1', aggnonce: toHex(aggnonce) })).status, 409);
    // and the set signs only what its policy allows
    allowed = false;
    const refused = await (await post(`${A}/musig/nonce`, { sessionId: 's2', nodeKey: node, tweak: toHex(tweak), msg: toHex(msg) })).json();
    assert.deepEqual(refused, { ok: false, why: 'a proof against this node is open' });
    const status = await (await fetch(`${A}/status`)).json();
    assert.deepEqual([status.network, status.k, status.members.length], ['regtest', 5, 7]);
  } finally { await seat.close(); await arb.close(); }
});
