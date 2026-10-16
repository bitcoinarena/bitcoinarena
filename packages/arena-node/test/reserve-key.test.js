// A FEDERATION'S RESERVE KEY (§27A.9.2, kanban #397 slice 2, custody "A"): its seven guardian seats make a 5-of-7 key with the
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
  } finally { await Promise.all(nodes.map((n) => n.close())); delete process.env.ARENA_RESERVE_DKG; }
});
