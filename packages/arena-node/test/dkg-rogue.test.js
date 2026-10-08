// A DISHONEST 2-OF-2 SIGNER NODE CAN NO LONGER MAKE THE COMMITTEE'S KEY ONE IT OWNS.
//
// Measured at 734a2ec, before round 1 carried a proof of knowledge: all four
// protocol facts were YES (accepted, honest share verified, combine emitted
// the attacker's key, the attacker alone signed) and on the daemon the rogue
// deal was taken 201 and the pool's output key was the attacker's alone.
//
// The slice's goal is a federation that signs without a trusted dealer. Our DKG
// round 1 carries no proof of knowledge (Zcash Foundation's frost-secp256k1-tr
// does). Without one, the signer node that deals LAST can publish a first commitment
// A0 = X - (honest A0) for a key X it owns, never knowing A0's secret, and
// solve its second commitment as a POINT so the one share it gives the honest
// signer node still lies on the polynomial. The group key is then X.
//
// The construction is unchanged, and the attacker now also attaches its best
// try at a proof - made with a secret it guesses, because it cannot know the
// one behind the A0 it published. Every fact must now be NO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import {
  epochId, dealContribution, acceptContribution, openMyContribution, combineShares,
  encodeContribution, decodeContribution, proveKnowledge,
} from '../../arena-protocol/src/dkg.js';
import { sealShare } from '../../arena-protocol/src/seal.js';
import { poolOutput, poolShare } from '../../arena-protocol/src/pool.js';
import { scalarFrom32, scalarTo32, FIELD } from '../../arena-protocol/src/shares.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const s = scalarFrom32(rand(32)); if (s > 0n && s < FIELD) return s; } };
const mod = (n) => ((n % FIELD) + FIELD) % FIELD;
const pow = (b, e) => { let r = 1n; b = mod(b); for (; e > 0n; e >>= 1n) { if (e & 1n) r = mod(r * b); b = mod(b * b); } return r; };
const inv = (a) => pow(a, FIELD - 2n);
const sortKeys = (ks) => [...ks].sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));
const MESSAGE = new Uint8Array(32).fill(0x6d);

/**
 * THE ROGUE CONTRIBUTION, built from nothing but the honest signer node's PUBLISHED
 * first commitment. `x` is the attacker's own key; the attacker never learns
 * the secret behind the A0 it publishes.
 */
async function rogueContribution({ honestA0, x, order, honestPub, attackerPub, epoch }) {
  const X = curve.pointFromScalar(x);
  const A0 = curve.combinePoints([{ point: X, coefficient: 1n }, { point: honestA0, coefficient: FIELD - 1n }]);
  const jh = order.findIndex((k) => toHex(k) === toHex(honestPub)) + 1;
  const ja = order.findIndex((k) => toHex(k) === toHex(attackerPub)) + 1;
  const r = scalar();                                   // the share the honest signer node will get
  const invj = inv(BigInt(jh));
  const A1 = curve.combinePoints([                      // so that A0 + jh*A1 = r*G
    { point: curve.pointFromScalar(r), coefficient: invj },
    { point: A0, coefficient: FIELD - invj },
  ]);
  const e = rand(32);
  const shares = [
    { signerNode: jh, signerNodePubkey: honestPub, sealed: await sealShare({ value: r, signerNode: jh, signerNodePubkey: honestPub, ephemeralSecret: e, curve }) },
    { signerNode: ja, signerNodePubkey: attackerPub, sealed: await sealShare({ value: 1n, signerNode: ja, signerNodePubkey: attackerPub, ephemeralSecret: e, curve }) },
  ].sort((a, b) => a.signerNode - b.signerNode);
  // ITS BEST TRY AT A PROOF: it does not know A0's secret, so it guesses one.
  const proof = proveKnowledge({ id: ja, secret: scalar(), commitment: A0, nonce: scalar(), curve });
  return { epochId: epoch, from: attackerPub, ephemeralPubkey: curve.pointX(e), needed: 2, commitments: [A0, A1], proof, shares };
}

/** What the attacker alone signs with: X made even, as the group key is. */
const attackerSecret = (x) => (curve.pointFromScalar(x)[0] === 0x02 ? x : FIELD - x);

test('2-of-2, in the protocol: a rogue contribution made after seeing the honest A0 is refused at every step', async () => {
  const hs = rand(32); const honestPub = curve.pointX(hs);
  const as = rand(32); const attackerPub = curve.pointX(as);
  const order = sortKeys([honestPub, attackerPub]);
  const epoch = epochId(order);

  const he = rand(32);
  const honest = (await dealContribution({ secret: scalarTo32(scalar()), signerNodes: order, epochId: epoch, from: honestPub,
    ephemeralSecret: he, ephemeralPubkey: curve.pointX(he), coefficients: [scalar()], needed: 2, curve })).contribution;

  const x = scalar();
  const rogue = await rogueContribution({ honestA0: honest.commitments[0], x, order, honestPub, attackerPub, epoch });

  const facts = {};
  const accepted = acceptContribution(rogue, { curve });
  facts.acceptContribution = accepted.ok;
  const openedRogue = await openMyContribution(rogue, { pubkey: honestPub, secret: hs, curve });
  facts.honestShareStillVerifies = openedRogue.ok;
  const openedOwn = await openMyContribution(honest, { pubkey: honestPub, secret: hs, curve });
  const combined = combineShares({ opened: [openedOwn, openedRogue.ok ? openedRogue : { share: { value: 1n }, signerNode: openedOwn.signerNode }],
    signerNodes: order, contributions: [honest, rogue], curve });
  const xEven = attackerSecret(x);
  facts.combineEmitsAttackersKey = combined.ok
    && toHex(combined.groupPublicKey.subarray(1)) === toHex(schnorr.getPublicKey(scalarTo32(xEven)));
  const sig = schnorr.sign(MESSAGE, scalarTo32(xEven));
  facts.attackerAloneSignsForGroupKey = combined.ok && schnorr.verify(sig, MESSAGE, combined.groupPublicKey.subarray(1));
  console.log('  FACTS (protocol, 2 of 2):', JSON.stringify(facts));

  // Before the proof of knowledge all four were true (734a2ec). Now each is refused, by the proof.
  assert.deepEqual(facts, {
    acceptContribution: false, honestShareStillVerifies: false,
    combineEmitsAttackersKey: false, attackerAloneSignsForGroupKey: false,
  });
  for (const why of [accepted.why, openedRogue.why, combined.why]) assert.match(why, /proof of knowledge does not verify/);
  // and the honest signer node's own contribution still passes every check
  assert.equal(acceptContribution(honest, { curve }).ok, true);
  assert.equal(openedOwn.ok, true);
});

test('2-of-2, on the daemon: the honest signer node still sends its A0 first, and the rogue deal built from it is refused', async () => {
  const log = [];
  const say = (s) => { log.push(s); };
  const honest = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve });
  const as = rand(32); const attackerPub = curve.pointX(as);
  let received = null;
  let rogueBytes = null;
  const stub = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/dkg')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = new Uint8Array(Buffer.concat(chunks));
        say(`attacker: POST /dkg from the honest daemon - holds its contribution (A0 ${toHex(decodeContribution(received).commitments[0]).slice(0, 16)}...) and has dealt NOTHING yet`);
        res.statusCode = 201; res.end('taken');
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/dkg')) {
      say(`attacker: GET /dkg from the honest daemon - answered ${rogueBytes ? 200 : 404}`);
      if (!rogueBytes) { res.statusCode = 404; return res.end('nothing dealt'); }
      return res.end(Buffer.from(rogueBytes));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  try {
    const honestPub = honest.round.pubkey;
    const order = sortKeys([honestPub, attackerPub]);
    honest.dkg.peers = [`http://127.0.0.1:${stub.address().port}`];

    say('honest: dkg.run(committee) starts');
    const first = await honest.dkg.run(order);
    say(`honest: run() returned ok=${first.ok} told=${first.told} got=${first.got} - ${first.why || ''}`);

    const x = scalar();
    const rogue = await rogueContribution({ honestA0: decodeContribution(received).commitments[0], x, order,
      honestPub, attackerPub, epoch: epochId(order) });
    rogueBytes = encodeContribution(rogue);
    const posted = await fetch(`http://127.0.0.1:${honest.port}/dkg`, { method: 'POST', body: rogueBytes });
    say(`attacker: POST /dkg (rogue, built from the honest A0) -> ${posted.status} ${(await posted.text()).trim()}`);

    const done = await honest.dkg.finish(order);
    say(`honest: finish() ok=${done.ok} group key ${done.groupPublicKey ? toHex(done.groupPublicKey).slice(0, 18) : '-'}... ${done.why || ''}`);
    const xEven = attackerSecret(x);
    const attackersKey = toHex(schnorr.getPublicKey(scalarTo32(xEven)));
    const facts = {
      honestPushedBeforeAttackerDealt: log.findIndex((l) => l.includes('has dealt NOTHING')) < log.findIndex((l) => l.includes('rogue')),
      honestAcceptedRogue: posted.status === 201,
      groupKeyIsAttackers: done.ok && toHex(done.groupPublicKey.subarray(1)) === attackersKey,
    };
    // and the pool's own output key - where a round's money would sit - is the attacker's to spend
    if (done.ok) {
      const out = poolOutput({ groupPublicKey: done.groupPublicKey, curve });
      const spendKey = poolShare({ share: xEven, tweak: out.tweak, negated: out.negated });
      facts.attackerAloneSpendsPoolOutput = schnorr.verify(schnorr.sign(MESSAGE, scalarTo32(spendKey)), MESSAGE, out.outputKey);
    } else facts.attackerAloneSpendsPoolOutput = false;      // no group key was ever formed
    console.log('  ORDER (daemon, 2 of 2):\n    ' + log.join('\n    '));
    console.log('  FACTS (daemon, 2 of 2):', JSON.stringify(facts));

    // Before (734a2ec): the rogue was taken 201, the key was the attacker's, and it spent the pool
    // output alone. The window is still there - the honest signer node still sends first - but it is useless.
    assert.deepEqual(facts, {
      honestPushedBeforeAttackerDealt: true, honestAcceptedRogue: false,
      groupKeyIsAttackers: false, attackerAloneSpendsPoolOutput: false,
    });
    assert.equal(posted.status, 409);
    assert.match(log.find((l) => l.includes('rogue')), /proof of knowledge does not verify/);
  } finally {
    stub.close();
    await honest.close();
  }
});
