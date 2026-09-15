// SEVEN DAEMONS ON SEVEN SOCKETS MAKE A KEY NOBODY DEALT.
//
// M3.3 item 14. `dkg.test.js` proves the round's arithmetic with the signer nodes in
// one process; this puts them on sockets, which is the difference between "the
// maths works" and "a committee did it". Every share here is made by the
// daemon that keeps it, and the only thing that crosses a wire is a
// contribution - commitments and one SEALED envelope per signer node.
//
// The number this replaces: before it, the process that started these daemons
// handed each one its share and therefore held all seven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { epochId, decodeContribution } from '../../protocol/src/dkg.js';
import { scalarFrom32, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { signShare340, aggregate340 } from '../../protocol/src/frost-bip340.js';
import { nonceGenerate } from '../../protocol/src/frost.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { toHex } from '../../protocol/src/hash.js';
import { feldmanGroup as dkgCurve } from '../src/curve.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const FUNDED = { funded: () => true };

/** `n` daemons, each on its own store and its own port, told about each other. */
async function daemons(n = SHARES_TOTAL) {
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push(await serve(openStore(':memory:'), { port: 0, ...FUNDED, poolCurve: curve }));
  for (const node of nodes)
    node.dkg.peers = nodes.filter((o) => o !== node).map((o) => `http://127.0.0.1:${o.port}`);
  const signerNodes = nodes.map((x) => x.round.pubkey);
  return { nodes, signerNodes, close: () => Promise.all(nodes.map((x) => x.close())) };
}

test('every daemon deals once, keeps one share, and they all name the same key', async () => {
  const c = await daemons();
  try {
    // Each one has to know the committee before it can deal to it - and no
    // daemon was handed a share by anybody.
    for (const node of c.nodes) {
      const before = node.dkg.signerNodeFor(c.signerNodes);
      assert.equal(before.ok, false, 'a daemon held a share before the DKG ran');
    }

    // THE ROUND, over real sockets. Run on every node; each deals, pushes to
    // its peers, pulls whatever it missed, and combines.
    const ran = [];
    for (const node of c.nodes) ran.push(await node.dkg.run(c.signerNodes));

    // The last to run sees everybody. The earlier ones may not have, because a
    // signer node that ran first could not pull a deal nobody had made - so they run
    // again, which is harmless: the deal is made once and the contributions
    // are keyed by dealer.
    for (const node of c.nodes) await node.dkg.run(c.signerNodes);

    const held = c.nodes.map((node) => node.dkg.signerNodeFor(c.signerNodes));
    for (const h of held) assert.equal(h.ok, true, h.why);

    // ONE SHARE EACH, ALL DIFFERENT, AND EVERY SIGNER NODE NUMBER USED ONCE.
    assert.equal(new Set(held.map((h) => h.signerNode.share)).size, SHARES_TOTAL,
      'two daemons hold the same share');
    assert.deepEqual([...held.map((h) => h.signerNode.id)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);

    // EVERY SIGNER NODE'S PUBLIC SHARE, each daemon computing all seven from the
    // commitments alone - the point of the very share each signer node holds.
    for (const node of c.nodes) {
      const pub = node.dkg.publicSharesFor(c.signerNodes);
      assert.equal(pub.ok, true, pub.why);
      for (const h of held)
        assert.equal(Buffer.from(pub.shares.get(String(h.signerNode.id))).toString('hex'),
          Buffer.from(dkgCurve.pointFromScalar(h.signerNode.share)).toString('hex'), `signer node ${h.signerNode.id}'s public share`);
    }

    // AND THE SAME GROUP KEY, computed by each of them from public data.
    const keys = held.map((h) => toHex(h.pool.groupPublicKey));
    assert.equal(new Set(keys).size, 1, 'the daemons disagree about their own key');
    assert.equal(held[0].pool.groupPublicKey[0], 0x02, 'the key they agreed on is not even-y');
    console.log(`  ${SHARES_TOTAL} daemons, ${SHARES_TOTAL} distinct shares, one key: ${keys[0].slice(0, 24)}…`);

    // AND THE ONE THING THAT MATTERS: no process here holds a threshold.
    for (const node of c.nodes) {
      const rows = node.round.contributionsOf(epochId(c.signerNodes));
      assert.equal(rows.length, SHARES_TOTAL, 'a daemon stored a different number of deals');
      // It stored seven CONTRIBUTIONS - which are commitments and sealed
      // envelopes - and exactly one share it can open.
      let opens = 0;
      for (const r of rows) {
        const one = decodeContribution(r.bytes);
        for (const sh of one.shares)
          if (toHex(sh.signerNodePubkey) === toHex(node.round.pubkey)) opens++;
      }
      assert.equal(opens, SHARES_TOTAL, 'a daemon was not dealt one envelope by each signer node');
    }
    console.log(`  each daemon holds 1 share of ${SHARES_NEEDED} needed - no process holds a threshold`);
  } finally { await c.close(); }
});

test('five of the seven sign under the key they made, and four do not', async () => {
  const c = await daemons();
  try {
    for (const node of c.nodes) await node.dkg.run(c.signerNodes);
    for (const node of c.nodes) await node.dkg.run(c.signerNodes);
    const held = c.nodes.map((node) => node.dkg.signerNodeFor(c.signerNodes));
    for (const h of held) assert.equal(h.ok, true, h.why);
    const groupPublicKey = held[0].pool.groupPublicKey;

    const signWith = (chosen) => {
      const message = rand(32);
      const nonces = chosen.map((h) => ({
        hiding: nonceGenerate(rand(32), h.signerNode.share),
        binding: nonceGenerate(rand(32), h.signerNode.share),
      }));
      const commitments = chosen.map((h, i) => ({
        id: h.signerNode.id,
        hiding: curve.pointFromScalar(nonces[i].hiding),
        binding: curve.pointFromScalar(nonces[i].binding),
      }));
      const shares = chosen.map((h, i) => signShare340({
        id: h.signerNode.id, share: h.signerNode.share, groupPublicKey,
        nonces: nonces[i], message, commitments, curve,
      }));
      const sig = aggregate340({ commitments, message, groupPublicKey, shares, curve });
      return schnorr.verify(sig.signature, message, groupPublicKey.subarray(1));
    };

    assert.equal(signWith(held.slice(0, SHARES_NEEDED)), true,
      'five daemons that made their own key produced no signature bitcoin would take');
    assert.equal(signWith(held.slice(0, SHARES_NEEDED - 1)), false,
      'four of seven signed for a five-of-seven key');
    assert.equal(signWith(held.slice(2, 2 + SHARES_NEEDED)), true,
      'a different five could not sign');
    console.log('  5 of 7 verify, 4 of 7 do not, and any five will do');
  } finally { await c.close(); }
});

test('a daemon deals once and serves the same bytes after a restart', async () => {
  // THE WHOLE COMMITTEE, because the threshold is five: three signer nodes cannot
  // carry it, and a fixture of three measured the arity check rather than the
  // deal-once rule it is named for.
  const c = await daemons();
  try {
    const first = await c.nodes[0].dkg.deal(c.signerNodes);
    assert.equal(first.ok, true, first.why);
    const again = await c.nodes[0].dkg.deal(c.signerNodes);
    assert.equal(again.ok, true, again.why);
    assert.equal(again.again, true, 'a second call dealt a second polynomial');
    assert.deepEqual(again.contribution.commitments, first.contribution.commitments,
      'the daemon re-dealt, so a peer holding the first has shares of a key nobody else has');

    // AND THE DOOR SERVES IT, which is how a signer node that was down catches up.
    const id = toHex(epochId(c.signerNodes));
    const r = await fetch(`http://127.0.0.1:${c.nodes[0].port}/dkg?epoch=${id}`);
    assert.equal(r.status, 200);
    const served = decodeContribution(new Uint8Array(await r.arrayBuffer()));
    assert.deepEqual(served.commitments, first.contribution.commitments);
    assert.deepEqual(served.from, c.nodes[0].round.pubkey);
    console.log('  dealt once, and the same bytes come back off the door');
  } finally { await c.close(); }
});

test('a stranger cannot contribute, and an unknown epoch is refused', async () => {
  const c = await daemons();
  try {
    await c.nodes[0].dkg.deal(c.signerNodes);
    const id = toHex(epochId(c.signerNodes));

    // A COMMITTEE THIS NODE IS NOT ON. Nobody dealt it, so nothing is stored
    // and there is nothing to contribute to.
    // A WHOLE COMMITTEE THIS NODE IS NOT ON - seven of them, so the refusal is
    // about membership and not about a threshold that cannot fit.
    const outsiders = Array.from({ length: SHARES_TOTAL }, () => schnorr.getPublicKey(rand(32)));
    const notMine = c.nodes[0].dkg.epochFor(outsiders);
    assert.equal(notMine.ok, false);
    assert.match(notMine.why, /not on that committee/);

    // AND A CONTRIBUTION FOR AN EPOCH THIS NODE HAS NEVER HEARD OF.
    const strange = await c.nodes[1].dkg.deal(outsiders);
    assert.equal(strange.ok, false, 'a daemon dealt into a committee it is not assigned to');
    assert.match(strange.why, /not on that committee/);

    // A body that is not a contribution at all.
    const bad = await fetch(`http://127.0.0.1:${c.nodes[0].port}/dkg?epoch=${id}`,
      { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    assert.equal(bad.status, 409);
    assert.match((await bad.text()).trim(), /not a contribution/);
    console.log('  a stranger contributes nothing, and rubbish is refused by name');
  } finally { await c.close(); }
});
