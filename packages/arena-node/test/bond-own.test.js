// A SEAT SERVES ONLY ITS OWN BOND (kanban #376, measured 2026-10-16 06:2xZ): the seven second-host seats shared one proof directory and all
// served transaction 74a47b5e, which is no seat's bond - a page proving a seat's endpoint is handed that seat's /bond, so a seat
// serving another's sends the player's door to a refusal. GET /bond now answers 409, by name, when the proof's advertisement names
// another node; its own, and a proof whose transaction names nobody this build reads, are served as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve, bondNamesWhom } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (nodePubkey) => ({
  nodePubkey, operatorId: 'somebody', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify'],
  endpoint: 'wss://seat.example', region: 'eu-west', capacityClass: 2, softwareHash: b32(3), settlementCapabilities: 0,
  lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(4),
  guardianOf: [], timestamp: 1788700000000n,
});
const proofOf = (nodePubkey) => {
  const sk = schnorr.utils.randomSecretKey();
  return { hex: toHex(bondTransaction(advertFor(nodePubkey), { signature: schnorr.sign(advertId(advertFor(nodePubkey)), sk) })), merkle: [], pos: 0 };
};

test('a bond proof names its node; one that is no transaction names nobody', () => {
  const k = b32(7);
  assert.equal(bondNamesWhom(proofOf(k)), toHex(k));
  assert.equal(bondNamesWhom({ hex: 'ab'.repeat(20), merkle: [], pos: 0 }), null);
  assert.equal(bondNamesWhom(null), null);
});

test('GET /bond: its own served, another node\'s refused 409 by name', async () => {
  let proof = null;
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, bondProof: () => proof });
  try {
    const me = (await (await fetch(`http://127.0.0.1:${node.port}/rounds`)).json()).node;
    assert.match(me, /^[0-9a-f]{64}$/);
    proof = proofOf(fromHex(me));
    const own = await fetch(`http://127.0.0.1:${node.port}/bond`);
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), proof);
    const other = toHex(b32(9));
    proof = proofOf(b32(9));
    const theirs = await fetch(`http://127.0.0.1:${node.port}/bond`);
    assert.equal(theirs.status, 409);
    assert.match(await theirs.text(), new RegExp(`node ${other}'s, not this node's`));
  } finally { await node.close(); }
});
