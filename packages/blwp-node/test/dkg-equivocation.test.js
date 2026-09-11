// ONE DEALER, TWO VALID CONTRIBUTIONS - AND NO HONEST SEAT KEEPS A SHARE OF EITHER KEY.
//
// Measured before the agreement step (this file at its first run): on 5 of 7,
// all six honest seats took the contribution meant for them (201) and finished
// - on 2 distinct group keys and 2 distinct pool addresses.
//
// Ownership is closed (0672ceb): a contribution without a valid proof of
// knowledge is refused. What is left is agreement. A dishonest seat deals two
// DIFFERENT contributions - both with valid proofs and valid shares for every
// seat, so every per-contribution check passes - and sends one to some honest
// seats and the other to the rest. Each honest seat combines what it holds.
//
// Now every seat signs the set it combined and keeps its share only when every
// seat signed the same one: the split is refused, naming the dealer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { epochId, dealContribution, encodeContribution } from '../../protocol/src/dkg.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { scalarFrom32, scalarTo32, FIELD } from '../../protocol/src/shares.js';
import { toHex } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const s = scalarFrom32(rand(32)); if (s > 0n && s < FIELD) return s; } };
const sortKeys = (ks) => [...ks].sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));

async function equivocate({ honestCount }) {
  const honest = [];
  for (let i = 0; i < honestCount; i++)
    honest.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, poolCurve: curve }));
  for (const node of honest)
    node.dkg.peers = honest.filter((o) => o !== node).map((o) => `http://127.0.0.1:${o.port}`);
  const attackerSecret = rand(32);
  const attackerPub = schnorr.getPublicKey(attackerSecret);
  const order = sortKeys([...honest.map((n) => n.round.pubkey), attackerPub]);
  const epoch = epochId(order);
  const needed = order.length === 2 ? 2 : 5;
  return { honest, attackerPub, order, epoch, needed, close: () => Promise.all(honest.map((n) => n.close())) };
}

async function contributionOf(c) {
  const e = rand(32);
  const dealt = await dealContribution({ secret: scalarTo32(scalar()), seats: c.order, epochId: c.epoch,
    from: c.attackerPub, ephemeralSecret: e, ephemeralPubkey: curve.pointX(e),
    coefficients: Array.from({ length: c.needed - 1 }, scalar), needed: c.needed, curve });
  assert.equal(dealt.ok, true, dealt.why);
  return encodeContribution(dealt.contribution);
}

test('5 of 7: a dealer sending two valid contributions to two halves of the honest seats', async () => {
  const c = await equivocate({ honestCount: 6 });
  try {
    for (const node of c.honest) await node.dkg.run(c.order);       // the six honest deals, exchanged
    const one = await contributionOf(c);
    const two = await contributionOf(c);
    const took = [];
    for (const [i, node] of c.honest.entries()) {
      const r = await fetch(`http://127.0.0.1:${node.port}/dkg`, { method: 'POST', body: i < 3 ? one : two });
      took.push(r.status);
    }
    const done = [];
    for (const node of c.honest) done.push(await node.dkg.finish(c.order));
    const finished = done.filter((d) => d.ok);
    const keys = new Set(finished.map((d) => toHex(d.groupPublicKey)));
    const addresses = new Set(finished.map((d) => toHex(poolOutput({ groupPublicKey: d.groupPublicKey, curve }).outputKey)));
    const facts = {
      postedStatuses: took.join(','), honestFinished: finished.length,
      distinctGroupKeys: keys.size, distinctPoolAddresses: addresses.size,
    };
    console.log('  FACTS (5 of 7, equivocating dealer):', JSON.stringify(facts));
    for (const d of done.filter((x) => !x.ok)) console.log('  refused:', d.why);

    // Each contribution is still valid on its own, so each is taken (201); the
    // disagreement is caught where it matters - before any seat keeps a share.
    assert.deepEqual(facts, { postedStatuses: '201,201,201,201,201,201', honestFinished: 0,
      distinctGroupKeys: 0, distinctPoolAddresses: 0 });
    const attacker = toHex(c.attackerPub).slice(0, 16);
    for (const d of done) {
      assert.match(d.why, /hold different contribution sets/);
      assert.ok(d.why.includes(attacker), 'the refusal does not name the dealer who equivocated');
    }
    for (const node of c.honest) assert.equal(node.dkg.seatFor(c.order).ok, false, 'a seat kept a share of a split key');
  } finally { await c.close(); }
});

test('2 of 2 and 7 of 7 with nobody equivocating: every seat agrees and keeps a share of one key', async () => {
  for (const n of [2, 7]) {
    const nodes = [];
    for (let i = 0; i < n; i++) nodes.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, poolCurve: curve }));
    try {
      for (const node of nodes) node.dkg.peers = nodes.filter((o) => o !== node).map((o) => `http://127.0.0.1:${o.port}`);
      const seats = nodes.map((x) => x.round.pubkey);
      for (const node of nodes) await node.dkg.run(seats);
      for (const node of nodes) await node.dkg.run(seats);
      const held = nodes.map((node) => node.dkg.seatFor(seats));
      for (const h of held) assert.equal(h.ok, true, h.why);
      const keys = new Set(held.map((h) => toHex(h.pool.groupPublicKey)));
      console.log(`  ${n} of ${n} seats, nobody equivocating: ${held.filter((h) => h.ok).length} kept a share, ${keys.size} group key`);
      assert.equal(keys.size, 1);
    } finally { await Promise.all(nodes.map((x) => x.close())); }
  }
});
