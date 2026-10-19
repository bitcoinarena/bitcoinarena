// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE KEY (§27A.9.2custody "A"): its seven guardian seats make a 5-of-7 key with the
// DKG a round's claim key uses, under the federation's own reserve epoch. Five sign a payout message, four cannot, every seat
// serves the same key at GET /reserves - and the key is never a round committee's key over the same seven nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { epochId, reserveEpochId } from '../../arena-protocol/src/dkg.js';
import { signShare340, aggregate340 } from '../../arena-protocol/src/frost-bip340.js';
import { nonceGenerate } from '../../arena-protocol/src/frost.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const sortKeys = (ks) => [...ks].sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));
const FED = new Uint8Array(32).fill(0x33);

test('seven guardian seats make a 5-of-7 reserve key: five sign, four do not, all serve it, and it is no round key', async () => {
  process.env.ARENA_RESERVE_DKG = '0';
  const nodes = [];
  for (let i = 0; i < 7; i++) nodes.push(await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve }));
  try {
    const members = sortKeys(nodes.map((n) => n.round.pubkey));
    const peersOf = (n) => nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    for (let pass = 0; pass < 2; pass++) for (const n of nodes) await n.reserves.make(toHex(FED), members, peersOf(n));
    const held = nodes.map((n) => n.reserves.dkgOf(toHex(FED)).signerNodeFor(members));
    for (const h of held) assert.equal(h.ok, true, h.why);
    const key = held[0].pool.groupPublicKey;
    assert.ok(held.every((h) => toHex(h.pool.groupPublicKey) === toHex(key)), 'one key on all seven');

    const signWith = (chosen) => {
      const message = rand(32);
      const nonces = chosen.map((h) => ({ hiding: nonceGenerate(rand(32), h.signerNode.share), binding: nonceGenerate(rand(32), h.signerNode.share) }));
      const commitments = chosen.map((h, i) => ({ id: h.signerNode.id, hiding: curve.pointFromScalar(nonces[i].hiding), binding: curve.pointFromScalar(nonces[i].binding) }));
      const shares = chosen.map((h, i) => signShare340({ id: h.signerNode.id, share: h.signerNode.share, groupPublicKey: key, nonces: nonces[i], message, commitments, curve }));
      return schnorr.verify(aggregate340({ commitments, message, groupPublicKey: key, shares, curve }).signature, message, key.subarray(1));
    };
    assert.equal(signWith(held.slice(0, 5)), true, 'five of seven sign');
    assert.equal(signWith(held.slice(2, 7)), true, 'any five');
    assert.equal(signWith(held.slice(0, 4)), false, 'four of seven do not');

    // the round DKG over the same seven makes another key: the reserve epoch is its own
    assert.notEqual(toHex(reserveEpochId(FED, members)), toHex(epochId(members)));
    for (let pass = 0; pass < 2; pass++) for (const n of nodes) await n.dkg.run(members, peersOf(n));
    const roundKey = nodes[0].dkg.signerNodeFor(members);
    assert.equal(roundKey.ok, true, roundKey.why);
    assert.notEqual(toHex(roundKey.pool.groupPublicKey), toHex(key), 'not the round committee\'s key');

    // GET /reserves on every seat: the same key, 5 needed, 7 public shares
    const served = await Promise.all(nodes.map(async (n) => (await (await fetch(`http://127.0.0.1:${n.port}/reserves`)).json()).federations.find((f) => f.federationId === toHex(FED))));
    assert.ok(served.every((f) => f && f.key === toHex(key) && f.needed === 5 && Object.keys(f.publicShares).length === 7), JSON.stringify(served[0]).slice(0, 300));

    // SLICE 4: WHAT IS HELD: seat 0 verified a 2,000 msat reserve output at a lock and kept it; its /reserves
    // counts it, the others hold nothing yet - then each takes it from seat 0 once ITS federation port holds that contract
    const OUT = { txid: new Uint8Array(32).fill(0x44), outIdx: 4n };
    const outHex = `${toHex(OUT.txid)}:4`;
    nodes[0].round.putDonationOutputs([{ outpoint: OUT, entryId: new Uint8Array(32).fill(0x55), roundId: new Uint8Array(32).fill(0x66), federationId: FED,
      recipientPk: key, amountMsat: 2000n, contractId: 'held', senderOnContract: false }]);
    const figures = async (n, q = '') => (await (await fetch(`http://127.0.0.1:${n.port}/reserves${q}`)).json());
    const f0 = await figures(nodes[0]);
    assert.deepEqual([f0.totalMsat, f0.entries, f0.federations[0].heldMsat, f0.paidIn.map((p) => [p.outpoint, p.amountMsat, p.federationId])],
      ['2000', 1, '2000', [[outHex, '2000', toHex(FED)]]]);
    assert.equal((await figures(nodes[1])).totalMsat, '0');
    const idOf = (f) => [toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk)].join('|');
    const { donationContractFields } = await import('../src/stake-lock-signer-node.js');
    const port = (holds) => ({ async status(o) { return { stored: holds && toHex(o.txid) === toHex(OUT.txid) ? { contractId: idOf(donationContractFields({ recipientPk: key, amountMsat: 2000n })) } : null }; },
      async contractId(f) { return idOf(f); } });
    const g = { [toHex(FED)]: { members, peers: [`http://127.0.0.1:${nodes[0].port}`] } };
    for (const [i, n] of nodes.slice(1).entries())
      await n.reserves.peerRound({ guardians: g, keyFor: async () => key, portOf: async () => port(i !== 5) });
    const totals = await Promise.all(nodes.map(async (n) => (await figures(n)).totalMsat));
    assert.deepEqual(totals, ['2000', '2000', '2000', '2000', '2000', '2000', '0'], 'six take it; the seat whose federation does not hold it keeps nothing');
    assert.equal((await figures(nodes[3], '?all=1')).federations[0].paidIn.length, 1);

    // SLICE 8: THE PAYOUT'S DOORS: nothing paid yet; a record that is no payout, or a commit for no plan, is refused
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${nodes[0].port}/reserve-payouts`)).json()).payouts, []);
    assert.deepEqual(f0.payouts, []);
    const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${nodes[0].port}${path}`, { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const [s1, r1] = await post('/reserve-payout/record', { proposal: 'ab'.repeat(32), state: 'PAID', planId: '00', plan: { federation: toHex(FED) } });
    assert.equal(r1.ok, false); assert.ok(s1 >= 400, String(s1));
    const [s2, r2] = await post('/reserve-payout/commit', { plan: { proposal: 'ab'.repeat(32), federation: toHex(FED) }, kind: 'tx' });
    assert.equal(r2.ok, false); assert.match(r2.why, /no passed vote/); assert.ok(s2 >= 400);
  } finally { await Promise.all(nodes.map((n) => n.close())); delete process.env.ARENA_RESERVE_DKG; }
});
